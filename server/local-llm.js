/**
 * Built-in local inference via node-llama-cpp (llama.cpp bindings).
 *
 * Lifecycle: missing → downloading → downloaded → loading → ready.
 * The native module is imported lazily so the server starts instantly and so
 * a machine without a working binary still gets the linter and cloud providers.
 *
 * Output is grammar-constrained: the JSON schema for the fix result is compiled
 * to a GBNF grammar and the sampler can only emit tokens that keep the output
 * valid. That is what makes a 4B model reliable here — it cannot wander off
 * into prose, truncate a string, or invent a field.
 */

import {
  MODELS,
  MODEL_DIR,
  bytesOnDisk,
  catalog,
  deleteModel as deleteModelFiles,
  freeSpaceBytes,
  isDownloaded,
  modelPath,
  selectedTier,
  spaceForDownload,
} from './models.js'

/**
 * A local fix has no natural end: a wedged generation would otherwise hold the
 * single model queue for the rest of the session. Generous on purpose — a fix
 * takes 15-35 s on a GPU and 30-90 s on a CPU-only machine, so the limit only
 * ever ends a run that was never going to finish.
 */
const GENERATION_TIMEOUT_MS = Number(process.env.PROMPTFIXER_FIX_TIMEOUT_MS) || 5 * 60_000

/**
 * Drop the model after this long with nothing to do, so an app left open next
 * to a browser and an IDE stops holding 2.5 GB it is not using. The next fix
 * pays the load again, which is why the default is generous. 0 disables it.
 */
const IDLE_UNLOAD_MS =
  process.env.PROMPTFIXER_IDLE_UNLOAD_MS !== undefined
    ? Number(process.env.PROMPTFIXER_IDLE_UNLOAD_MS)
    : 15 * 60_000

export class LocalModelError extends Error {
  constructor(message, code, status = 400) {
    super(message)
    this.name = 'LocalModelError'
    this.code = code
    this.status = status
  }
}

let nativeModule = null
async function native() {
  if (!nativeModule) nativeModule = await import('node-llama-cpp')
  return nativeModule
}

const state = {
  tier: selectedTier(),
  phase: 'idle', // idle | downloading | loading | ready | error   (missing/downloaded are derived)
  progress: { downloaded: 0, total: 0 },
  error: null,
  abort: null,
  llama: null,
  model: null,
  context: null,
  loadedTier: null,
  gpu: null,
  device: null,
  grammars: new Map(),
  queue: Promise.resolve(),
  lastRun: null,
  active: 0,
  // Download rate, smoothed over the last sample; null until two samples exist.
  rate: { bytesPerSecond: null, at: 0, bytes: 0 },
  // 0..1 while the model is being read into memory.
  loadPercent: 0,
  idleTimer: null,
  autoUnloaded: false,
}

// --- status ------------------------------------------------------------------

export function getStatus() {
  const tier = state.tier
  const model = MODELS[tier]
  const downloaded = isDownloaded(tier)
  const loaded = state.loadedTier === tier && !!state.model

  let phase = state.phase
  if (phase === 'idle' || (phase === 'ready' && !loaded)) {
    phase = loaded ? 'ready' : downloaded ? 'downloaded' : 'missing'
  }

  const total = state.progress.total || model.bytes
  const remaining = Math.max(0, total - state.progress.downloaded)
  const bps = state.rate.bytesPerSecond
  // The context the model actually loaded with can be smaller than the catalog
  // says on a VRAM-starved machine, so prefer the real one once it exists.
  const contextSize = (loaded && state.context?.contextSize) || model.contextSize

  // Built once and reused below. The UI polls this route every 1.2s during a
  // download, and asking each tier for its size separately listed the model
  // directory eight times per call — while the same event loop was writing the
  // download it was reporting on.
  const tiers = catalog().map((c) => {
    const onDisk = bytesOnDisk(c.id)
    return { ...c, downloaded: isDownloaded(c.id), onDisk }
  })

  return {
    tier,
    model: { id: model.id, label: model.label, bytes: model.bytes, blurb: model.blurb },
    path: modelPath(tier),
    modelDir: MODEL_DIR,
    phase,
    downloaded,
    loaded,
    progress: {
      downloaded: state.progress.downloaded,
      total,
      percent: total ? Math.min(100, Math.round((state.progress.downloaded / total) * 100)) : 0,
      bytesPerSecond: bps,
      // Null rather than Infinity while the rate is unknown, so the interface
      // has one thing to test for instead of two.
      etaSeconds: bps && bps > 0 ? Math.round(remaining / bps) : null,
    },
    // 0..100 while phase is 'loading'.
    loadPercent: Math.round(state.loadPercent * 100),
    gpu: state.gpu,
    device: state.device,
    error: state.error,
    lastRun: state.lastRun,
    busy: state.active > 0,
    // How much room the prompt has once the reply is reserved, so the editor can
    // warn before the wait instead of the model refusing after it.
    inputBudgetTokens: outputBudget(contextSize, 2048).budget,
    // Set when the model was dropped for being idle, so the interface can say so
    // rather than letting the next fix look like a cold start for no reason.
    autoUnloaded: state.autoUnloaded,
    disk: {
      free: freeSpaceBytes(),
      used: tiers.reduce((n, c) => n + c.onDisk, 0),
    },
    catalog: tiers,
  }
}

/** The tier the user currently has selected (env/RAM default until changed). */
export function currentTier() {
  return state.tier
}

export function selectTier(tier) {
  if (!tier || !MODELS[tier]) throw new LocalModelError(`Unknown model tier "${tier}".`, 'BAD_TIER')
  if (tier !== state.tier) {
    // The download task and its progress belong to state.tier; switching under
    // it would relabel the running transfer as the new tier and never fetch it.
    if (state.phase === 'downloading') {
      throw new LocalModelError(
        `A download for ${MODELS[state.tier].label} is in progress. Cancel it before switching tiers.`,
        'DOWNLOAD_BUSY',
        409
      )
    }
    state.tier = tier
    state.error = null
    state.progress = { downloaded: 0, total: 0 }
    if (state.phase === 'error' || state.phase === 'ready') state.phase = 'idle'
  }
  return getStatus()
}

// --- download ----------------------------------------------------------------

export async function startDownload(tier = state.tier) {
  if (tier !== state.tier) selectTier(tier)
  if (state.phase === 'downloading') return getStatus()
  if (isDownloaded(tier)) return getStatus()

  const spec = MODELS[tier]

  // Checked before the downloader starts, so "not enough room" is an answer in
  // under a second rather than an error an hour into a 2.5 GB transfer. Unknown
  // free space never blocks: spaceForDownload() reports ok in that case.
  const room = spaceForDownload(tier)
  if (!room.ok) {
    const gb = (n) => `${(n / 1024 ** 3).toFixed(1)} GB`
    throw new LocalModelError(
      `Not enough disk space for ${spec.label}: ${gb(room.needed)} needed, ${gb(room.free)} free on the drive holding ${MODEL_DIR}. Free some space, or delete a model you are not using.`,
      'NO_SPACE',
      507
    )
  }

  const { createModelDownloader } = await native()

  state.phase = 'downloading'
  state.error = null
  state.progress = { downloaded: 0, total: spec.bytes }
  state.rate = { bytesPerSecond: null, at: Date.now(), bytes: 0 }
  const controller = new AbortController()
  state.abort = controller

  // Runs in the background; the UI polls getStatus().
  ;(async () => {
    try {
      const downloader = await createModelDownloader({
        modelUri: spec.uri,
        dirPath: MODEL_DIR,
        showCliProgress: false,
        skipExisting: true,
        deleteTempFileOnCancel: false, // resumable
        onProgress: ({ totalSize, downloadedSize }) => {
          state.progress = { downloaded: downloadedSize, total: totalSize || spec.bytes }
          // Sampled over a window rather than per callback: the callback fires
          // far too often for the quotient to be stable, and over the whole
          // download an early stall would drag the estimate down for an hour.
          const now = Date.now()
          const ms = now - state.rate.at
          if (ms >= 1000) {
            const bytes = downloadedSize - state.rate.bytes
            const sample = (bytes / ms) * 1000
            const prev = state.rate.bytesPerSecond
            state.rate = {
              // Exponential smoothing; the first sample stands on its own.
              bytesPerSecond: prev === null ? sample : prev * 0.7 + sample * 0.3,
              at: now,
              bytes: downloadedSize,
            }
          }
        },
      })
      await downloader.download({ signal: controller.signal })
      finishDownload(tier, downloader.entrypointFilePath)
    } catch (err) {
      if (controller.signal.aborted) {
        state.phase = 'idle'
      } else {
        state.phase = 'error'
        state.error = `Download failed: ${err.message}`
      }
    } finally {
      state.abort = null
    }
  })()

  return getStatus()
}

export function cancelDownload() {
  state.abort?.abort()
  return getStatus()
}

/**
 * A download can "complete" without leaving a usable file (upstream re-quantised
 * to a different size, or skipExisting kept a wrong-sized file). Without this
 * check the phase derives back to 'missing' with no error and the Download
 * button becomes a silent no-op.
 */
export function finishDownload(tier, filePath) {
  if (isDownloaded(tier)) {
    state.phase = 'idle'
    state.error = null
  } else {
    const spec = MODELS[tier]
    state.phase = 'error'
    state.error =
      `Download finished at ${filePath} but the file did not pass validation ` +
      `(expected about ${(spec.bytes / 1024 ** 3).toFixed(2)} GB at ${modelPath(tier)}). Delete it and try again.`
  }
  return getStatus()
}

// --- load --------------------------------------------------------------------

/**
 * One job at a time: the context has a single sequence, and disposing it under
 * a running generation crashes that generation. Every public entry point that
 * touches the model (load, unload, complete) goes through this queue; the
 * `*Now` variants below are the unqueued bodies for use *inside* a job.
 */
function serialize(fn) {
  // `active` counts queued + running jobs; the UI reads it as `busy` to keep
  // Fix disabled after a cancel until the aborted generation has actually stopped.
  state.active += 1
  clearIdleUnload()
  const run = state.queue.then(fn, fn).finally(() => {
    state.active -= 1
    if (state.active === 0 && state.model) armIdleUnload()
  })
  state.queue = run.catch(() => {})
  return run
}

/**
 * Arm the idle release. Called whenever a job finishes, so the countdown always
 * measures time since the model was last useful. unref() so a pending timer
 * never keeps the process alive — the desktop quit handler depends on that.
 */
function armIdleUnload() {
  clearIdleUnload()
  if (!(IDLE_UNLOAD_MS > 0) || !state.model) return
  state.idleTimer = setTimeout(() => {
    state.idleTimer = null
    // Only when still idle: a job that started in the meantime owns the model.
    if (state.active > 0 || !state.model) return
    unload()
      .then(() => {
        state.autoUnloaded = true
      })
      .catch(() => {})
  }, IDLE_UNLOAD_MS)
  state.idleTimer.unref?.()
}

function clearIdleUnload() {
  if (state.idleTimer) clearTimeout(state.idleTimer)
  state.idleTimer = null
}

async function unloadNow() {
  clearIdleUnload()
  const { context, model } = state
  state.context = null
  state.model = null
  state.loadedTier = null
  state.grammars.clear()
  if (state.phase === 'ready') state.phase = 'idle'
  await context?.dispose().catch(() => {})
  await model?.dispose().catch(() => {})
}

export const unload = () => serialize(unloadNow)

/** Load `tier` if it is not the one already loaded. Runs inside the queue. */
async function loadNow(tier) {
  if (state.model && state.context && state.loadedTier === tier) return
  if (!isDownloaded(tier)) {
    throw new LocalModelError(
      `The local model (${MODELS[tier].label}) is not downloaded yet. Use the download button, or run: npm run setup`,
      'MODEL_MISSING'
    )
  }

  state.phase = 'loading'
  state.error = null
  state.loadPercent = 0
  state.autoUnloaded = false
  try {
    await unloadNow()
    const { getLlama } = await native()
    if (!state.llama) {
      // `build` defaults to 'auto', which on a machine with no matching
      // prebuilt binary resolves a release from GitHub, clones llama.cpp and
      // may fetch a toolchain — real network traffic, from an app whose whole
      // claim is that it does not do that, with nobody having asked for it.
      // Refuse instead: a missing binary is a clear error, not a silent
      // download. The installer ships the binary, so this only ever fires on a
      // platform we do not build for.
      state.llama = await getLlama({ logLevel: 'error', build: 'never', skipDownload: true })
      state.gpu = state.llama.gpu || 'cpu'
      const names = await state.llama.getGpuDeviceNames().catch(() => [])
      state.device = names[0] || null
    }
    state.model = await state.llama.loadModel({
      modelPath: modelPath(tier),
      gpuLayers: 'auto',
      // Turns the 15-second bare spinner into a real bar.
      onLoadProgress: (fraction) => {
        state.loadPercent = Math.max(0, Math.min(1, fraction))
      },
    })
    // Reading the file is the long part; the context is quick but not free.
    state.loadPercent = 1
    state.context = await state.model.createContext({
      contextSize: { max: MODELS[tier].contextSize },
    })
    state.loadedTier = tier
    state.phase = 'ready'
  } catch (err) {
    state.loadPercent = 0
    state.phase = 'error'
    state.error = `Could not load the model: ${err.message}`
    await unloadNow()
    throw new LocalModelError(state.error, 'LOAD_FAILED', 500)
  }
}

/**
 * The tier is read when the job starts, not when it was requested, so a load
 * queued behind a preload always ends up on the tier the user actually wants.
 */
export const ensureLoaded = () => serialize(() => loadNow(state.tier))

// --- inference ---------------------------------------------------------------

async function grammarFor(schema) {
  const key = JSON.stringify(schema)
  if (!state.grammars.has(key)) {
    state.grammars.set(key, await state.llama.createGrammarForJsonSchema(schema))
  }
  return state.grammars.get(key)
}

/**
 * Split a context between input and output. The context node-llama-cpp
 * resolves can be far smaller than the catalog max on a VRAM-starved machine,
 * so the output cap is clamped to half of it; otherwise the input budget goes
 * negative and every prompt is rejected as "too long".
 */
export function outputBudget(contextSize, maxTokens, reserve = 64) {
  const maxOut = Math.max(0, Math.min(maxTokens, Math.floor(contextSize / 2)))
  return { maxOut, budget: contextSize - maxOut - reserve }
}

/**
 * `onStage` names what the caller is waiting for — 'queued', 'loading',
 * 'generating' — so a spinner can say which of the three it is instead of
 * looking the same for all of them. `onTextChunk` receives the raw model
 * output as it arrives; with a grammar that is partial JSON, which is the
 * caller's problem to parse.
 */
export async function complete({
  system,
  user,
  temperature = 0.3,
  maxTokens = 2048,
  jsonSchema,
  signal,
  onStage,
  onTextChunk,
}) {
  // Capture the tier the caller asked for: another request may reselect
  // before this job reaches the front of the queue.
  const tier = state.tier
  const stage = (name, detail) => {
    try {
      onStage?.(name, detail)
    } catch {
      /* a reporting callback must never fail the generation */
    }
  }

  // Read before serialize() increments it, so it counts the jobs in front.
  const ahead = state.active
  if (ahead > 0) stage('queued', { ahead })

  return serialize(async () => {
    if (!(state.model && state.context && state.loadedTier === tier)) stage('loading')
    await loadNow(tier)
    const { LlamaChatSession } = await native()
    const spec = MODELS[tier]
    const contextSize = state.context.contextSize
    const inputTokens = state.model.tokenize(`${system}\n${user}`).length
    const { maxOut, budget } = outputBudget(contextSize, maxTokens)
    if (budget <= 0) {
      throw new LocalModelError(
        `The local model loaded with a context of only ${contextSize} tokens, too small for this hardware/model. Pick a smaller model tier or free up GPU memory.`,
        'CONTEXT_TOO_SMALL',
        500
      )
    }
    if (inputTokens > budget) {
      throw new LocalModelError(
        `Prompt is too long for the local model (${inputTokens} tokens; the ${contextSize}-token context leaves room for ${budget} once ${maxOut} are reserved for the reply). Shorten it or switch to a cloud provider.`,
        'TOO_LONG',
        413
      )
    }

    const sequence = state.context.getSequence()
    const session = new LlamaChatSession({ contextSequence: sequence, systemPrompt: system })
    const started = Date.now()

    // The caller's signal and the time limit, as one signal the sampler can
    // take. Kept separate afterwards so a run that ran out of time is reported
    // as that and not as "you cancelled it".
    const stop = new AbortController()
    let timedOut = false
    const onCallerAbort = () => stop.abort()
    signal?.addEventListener('abort', onCallerAbort, { once: true })
    const timer =
      GENERATION_TIMEOUT_MS > 0
        ? setTimeout(() => {
            timedOut = true
            stop.abort()
          }, GENERATION_TIMEOUT_MS)
        : null
    timer?.unref?.()

    try {
      const grammar = jsonSchema ? await grammarFor(jsonSchema) : undefined
      stage('generating')
      const text = await session.prompt(user, {
        grammar,
        temperature,
        maxTokens: maxOut,
        signal: stop.signal,
        onTextChunk,
      })
      const elapsedMs = Date.now() - started
      const outputTokens = state.model.tokenize(text).length
      state.lastRun = {
        inputTokens,
        outputTokens,
        elapsedMs,
        tokensPerSecond: elapsedMs ? Math.round((outputTokens / elapsedMs) * 1000 * 10) / 10 : null,
      }
      return {
        text,
        model: spec.label,
        usage: { inputTokens, outputTokens },
      }
    } catch (err) {
      if (timedOut) {
        throw new LocalModelError(
          `The local model did not finish within ${Math.round(GENERATION_TIMEOUT_MS / 1000)}s and was stopped. Try a shorter prompt or a smaller model tier (PROMPTFIXER_FIX_TIMEOUT_MS changes the limit).`,
          'TIMEOUT',
          504
        )
      }
      throw err
    } finally {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onCallerAbort)
      // Synchronous in node-llama-cpp; a thrown error here would mask the result.
      try {
        session.dispose({ disposeSequence: true })
      } catch {
        /* already disposed */
      }
    }
  })
}

/**
 * Delete a tier's files, unloading it first when it is the one in memory —
 * llama.cpp maps the file, so deleting it underneath a loaded model is a crash
 * on some platforms and a silent corruption on others.
 */
export async function removeModel(tier) {
  if (!MODELS[tier]) throw new LocalModelError(`Unknown model tier "${tier}".`, 'BAD_TIER')
  if (state.phase === 'downloading' && tier === state.tier) {
    throw new LocalModelError(
      `${MODELS[tier].label} is downloading. Pause the download before deleting it.`,
      'DOWNLOAD_BUSY',
      409
    )
  }
  if (state.loadedTier === tier) await unload()
  try {
    const result = deleteModelFiles(tier)
    if (tier === state.tier && state.phase === 'error') {
      state.phase = 'idle'
      state.error = null
    }
    return { ...result, status: getStatus() }
  } catch (err) {
    throw new LocalModelError(err.message, 'DELETE_FAILED', 500)
  }
}

/** Warm the model in the background so the first fix is not the slow one. */
export function preload() {
  if (isDownloaded(state.tier)) {
    ensureLoaded().catch(() => {})
  }
}
