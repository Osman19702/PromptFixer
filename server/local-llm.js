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

import { MODELS, MODEL_DIR, isDownloaded, modelPath, selectedTier, catalog } from './models.js'

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
    },
    gpu: state.gpu,
    device: state.device,
    error: state.error,
    lastRun: state.lastRun,
    busy: (state.active || 0) > 0,
    catalog: catalog().map((c) => ({ ...c, downloaded: isDownloaded(c.id) })),
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
  const { createModelDownloader } = await native()

  state.phase = 'downloading'
  state.error = null
  state.progress = { downloaded: 0, total: spec.bytes }
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
  state.active = (state.active || 0) + 1
  const run = state.queue.then(fn, fn).finally(() => {
    state.active -= 1
  })
  state.queue = run.catch(() => {})
  return run
}

async function unloadNow() {
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
  try {
    await unloadNow()
    const { getLlama } = await native()
    if (!state.llama) {
      state.llama = await getLlama({ logLevel: 'error' })
      state.gpu = state.llama.gpu || 'cpu'
      const names = await state.llama.getGpuDeviceNames().catch(() => [])
      state.device = names[0] || null
    }
    state.model = await state.llama.loadModel({
      modelPath: modelPath(tier),
      gpuLayers: 'auto',
    })
    state.context = await state.model.createContext({
      contextSize: { max: MODELS[tier].contextSize },
    })
    state.loadedTier = tier
    state.phase = 'ready'
  } catch (err) {
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

export async function complete({ system, user, temperature = 0.3, maxTokens = 2048, jsonSchema, signal }) {
  // Capture the tier the caller asked for: another request may reselect
  // before this job reaches the front of the queue.
  const tier = state.tier

  return serialize(async () => {
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
    try {
      const grammar = jsonSchema ? await grammarFor(jsonSchema) : undefined
      const text = await session.prompt(user, { grammar, temperature, maxTokens: maxOut, signal })
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
    } finally {
      // Synchronous in node-llama-cpp; a thrown error here would mask the result.
      try {
        session.dispose({ disposeSequence: true })
      } catch {
        /* already disposed */
      }
    }
  })
}

/** Warm the model in the background so the first fix is not the slow one. */
export function preload() {
  if (isDownloaded(state.tier)) {
    ensureLoaded().catch(() => {})
  }
}
