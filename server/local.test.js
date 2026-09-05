/**
 * Local model state machine: the serialized load/unload/generate queue, tier
 * switching, download bookkeeping and the context budget. `node-llama-cpp` is
 * replaced with an in-memory mock via module hooks, so no native binary and
 * no model file is ever loaded; "downloaded" tiers are tiny placeholder files
 * against a shrunk catalog size.
 * Run with: npm test
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptfixer-local-'))
process.env.PROMPTFIXER_MODEL_DIR = modelDir
process.env.PROMPTFIXER_MODEL = 'default'

// --- mock backend ------------------------------------------------------------
//
// Every async step (download, model load, prompt) is gated on a promise the
// test releases by hand, which is what lets the ordering assertions below be
// deterministic. State lives on globalThis so the test can reach it.

const MOCK_SOURCE = `
const m = (globalThis.__llamaMock = {
  downloaders: [], models: [], contexts: [], sessions: [], holdLoad: false, contextSize: 8192,
})
function deferred() {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
export async function createModelDownloader(opts) {
  const gate = deferred()
  const dl = {
    opts, gate, entrypointFilePath: opts.dirPath + '/mock-download',
    async download({ signal } = {}) {
      if (signal?.aborted) throw signal.reason
      const onAbort = () => gate.reject(signal.reason)
      signal?.addEventListener('abort', onAbort)
      try { await gate.promise } finally { signal?.removeEventListener('abort', onAbort) }
    },
  }
  m.downloaders.push(dl)
  return dl
}
export async function getLlama() {
  return {
    gpu: 'cpu',
    getGpuDeviceNames: async () => ['mock-gpu'],
    async createGrammarForJsonSchema(schema) { return { schema } },
    async loadModel({ modelPath }) {
      const gate = deferred()
      const model = {
        modelPath, gate, disposed: false,
        tokenize: (s) => s.split(/\\s+/).filter(Boolean),
        async createContext() {
          const ctx = { contextSize: m.contextSize, disposed: false, getSequence() { return {} }, async dispose() { this.disposed = true } }
          m.contexts.push(ctx)
          return ctx
        },
        async dispose() { this.disposed = true },
      }
      m.models.push(model)
      if (!m.holdLoad) gate.resolve()
      await gate.promise
      return model
    },
  }
}
export class LlamaChatSession {
  constructor(o) { this.o = o; this.gate = deferred(); this.disposed = false; m.sessions.push(this) }
  async prompt(user, opts) { this.user = user; this.opts = opts; return this.gate.promise }
  dispose() { this.disposed = true }
}
`

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'node-llama-cpp') return { url: 'mock:node-llama-cpp', shortCircuit: true }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === 'mock:node-llama-cpp') return { format: 'module', source: MOCK_SOURCE, shortCircuit: true }
    return next(url, context)
  },
})

const models = await import('./models.js')
const llm = await import('./local-llm.js')
const { MODELS } = models

// Shrink the catalog so a 16-byte placeholder counts as a complete download.
// Both modules share this object, so isDownloaded() and the status agree.
for (const tier of Object.keys(MODELS)) MODELS[tier].bytes = 16

const mock = () => globalThis.__llamaMock
const tick = () => new Promise((r) => setImmediate(r))
const fileFor = (tier) => path.join(modelDir, `hf_${MODELS[tier].uri.split('/')[0].replace(/^hf:/, '')}_${MODELS[tier].file}`)
const placeModel = (tier) => fs.writeFileSync(fileFor(tier), 'x'.repeat(16))
const removeModel = (tier) => fs.rmSync(fileFor(tier), { force: true })

const args = { system: 'you are a tool', user: 'fix this', maxTokens: 2048 }

after(async () => {
  await llm.unload()
  fs.rmSync(modelDir, { recursive: true, force: true })
})

// --- RAM threshold (finding 28) ----------------------------------------------

test('recommendedTier() treats what the OS reports for an 8 GB machine as 8 GB', () => {
  const real = os.totalmem
  try {
    os.totalmem = () => 7.8 * 1024 ** 3 // firmware/iGPU reservation on a real 8 GB box
    assert.equal(models.recommendedTier(), 'default')
    os.totalmem = () => 7.5 * 1024 ** 3
    assert.equal(models.recommendedTier(), 'default')
    os.totalmem = () => 7.4 * 1024 ** 3
    assert.equal(models.recommendedTier(), 'lite')
    os.totalmem = () => 3.7 * 1024 ** 3
    assert.equal(models.recommendedTier(), 'lite')
  } finally {
    os.totalmem = real
  }
})

// --- pure budget maths (finding 26) -----------------------------------------

test('outputBudget() clamps the reply to the context so the input budget never goes negative', () => {
  assert.deepEqual(llm.outputBudget(8192, 2048), { maxOut: 2048, budget: 6080 })
  assert.deepEqual(llm.outputBudget(1024, 2048), { maxOut: 512, budget: 448 })
  assert.ok(llm.outputBudget(24, 2048).budget <= 0, 'a tiny context is reported, not silently used')
})

// --- missing model, empty dir -------------------------------------------------

test('complete() reports MODEL_MISSING for the selected tier when nothing is downloaded', async () => {
  assert.equal(llm.getStatus().phase, 'missing')
  await assert.rejects(llm.complete(args), (err) => {
    assert.equal(err.code, 'MODEL_MISSING')
    assert.match(err.message, /Qwen3 4B/)
    return true
  })
  assert.equal(mock(), undefined, 'the backend must not be imported for a missing model')
})

// --- download bookkeeping (findings 25, 27) -----------------------------------

test('switching tiers mid-download is refused instead of relabelling the running download', async () => {
  const before = await llm.startDownload('default')
  assert.equal(before.phase, 'downloading')
  assert.equal(mock().downloaders.length, 1)
  mock().downloaders[0].opts.onProgress({ totalSize: 16, downloadedSize: 8 })

  assert.throws(() => llm.selectTier('quality'), (err) => {
    assert.equal(err.code, 'DOWNLOAD_BUSY')
    assert.equal(err.status, 409)
    assert.match(err.message, /Qwen3 4B/)
    return true
  })
  await assert.rejects(llm.startDownload('quality'), /in progress/)
  assert.equal(mock().downloaders.length, 1, 'no second downloader was created')

  const status = llm.getStatus()
  assert.equal(status.tier, 'default')
  assert.equal(status.phase, 'downloading')
  assert.equal(status.progress.total, MODELS.default.bytes)
  assert.equal(status.progress.percent, 50)

  llm.cancelDownload()
  await tick()
  assert.equal(llm.getStatus().phase, 'missing')
  // Selecting after the cancel works and resets the stale progress.
  assert.equal(llm.selectTier('quality').progress.downloaded, 0)
  llm.selectTier('default')
})

test('a download that finishes without a valid file ends in phase error with a message', async () => {
  await llm.startDownload('default')
  const dl = mock().downloaders.at(-1)
  dl.gate.resolve() // "completes" without writing anything usable
  await tick()
  const status = llm.getStatus()
  assert.equal(status.phase, 'error')
  assert.match(status.error, /did not pass validation/)
  assert.match(status.error, /Delete it and try again/)

  // The same completion step reports success once the file is there.
  placeModel('default')
  assert.equal(llm.finishDownload('default', dl.entrypointFilePath).phase, 'downloaded')
  assert.equal(llm.getStatus().error, null)
})

// --- serialized load/unload/generate (findings 23, 24) -----------------------

test('a tier switch and an unload queued behind a running generation wait for it', async () => {
  placeModel('lite')
  llm.selectTier('lite')
  const first = llm.complete(args)
  while (mock().sessions.length < 1) await tick()
  const [ctxA] = mock().contexts
  const sessionA = mock().sessions[0]

  // A second request on another tier plus an explicit unload, both while A runs.
  llm.selectTier('default')
  const second = llm.complete(args)
  const unloaded = llm.unload()
  await tick()
  await tick()
  assert.equal(ctxA.disposed, false, 'the running job keeps its context')
  assert.equal(mock().models.length, 1, 'no second model load started under the running job')

  sessionA.gate.resolve('{"a":1}')
  const resultA = await first
  assert.equal(resultA.model, 'Qwen2.5 1.5B Instruct')
  assert.equal(resultA.text, '{"a":1}')

  while (mock().sessions.length < 2) await tick()
  assert.equal(ctxA.disposed, true, 'the switch happened only after A finished')
  assert.ok(mock().models[1].modelPath.endsWith(MODELS.default.file))
  mock().sessions[1].gate.resolve('{"b":2}')
  const resultB = await second
  assert.equal(resultB.model, 'Qwen3 4B Instruct (2507)')

  await unloaded
  assert.equal(llm.getStatus().loaded, false)
  assert.equal(mock().contexts[1].disposed, true)
})

test('a load in flight for another tier does not satisfy a request for the selected one', async () => {
  await llm.unload()
  mock().holdLoad = true
  const loadsBefore = mock().models.length
  try {
    llm.selectTier('default')
    const warm = llm.ensureLoaded()
    while (mock().models.length < loadsBefore + 1) await tick()

    // The user picks lite while the default preload is still loading.
    llm.selectTier('lite')
    const wanted = llm.complete(args)
    mock().models[loadsBefore].gate.resolve()
    await warm
    assert.equal(llm.getStatus().loaded, false, 'default is loaded, but lite is what is selected')

    while (mock().models.length < loadsBefore + 2) await tick()
    assert.ok(mock().models[loadsBefore + 1].modelPath.endsWith(MODELS.lite.file), 'a second load, for lite')
    mock().models[loadsBefore + 1].gate.resolve()
    while (mock().sessions.length < 3) await tick()
    mock().sessions[2].gate.resolve('{}')
    assert.equal((await wanted).model, 'Qwen2.5 1.5B Instruct')
  } finally {
    mock().holdLoad = false
  }
})

test('a request for a tier that is not on disk fails even while another tier is loading', async () => {
  await llm.unload()
  removeModel('lite')
  mock().holdLoad = true
  const loadsBefore = mock().models.length
  try {
    llm.selectTier('default')
    const warm = llm.ensureLoaded()
    while (mock().models.length < loadsBefore + 1) await tick()
    llm.selectTier('lite')
    const wanted = llm.complete(args)
    mock().models[loadsBefore].gate.resolve()
    await warm
    await assert.rejects(wanted, (err) => {
      assert.equal(err.code, 'MODEL_MISSING')
      assert.match(err.message, /Qwen2\.5 1\.5B/)
      return true
    })
    assert.equal(mock().models.length, loadsBefore + 1, 'nothing else was loaded')
  } finally {
    mock().holdLoad = false
    llm.selectTier('default')
  }
})

// --- budget under a small resolved context (finding 26) ----------------------

test('a small resolved context clamps maxTokens instead of rejecting every prompt', async () => {
  await llm.unload()
  mock().contextSize = 1024
  llm.selectTier('default')
  try {
    const run = llm.complete(args)
    while (mock().sessions.length < 4) await tick()
    const session = mock().sessions[3]
    assert.equal(session.opts.maxTokens, 512, 'reply capped at half the context')
    session.gate.resolve('{}')
    await run

    // A prompt that really is too long says what the limit is.
    const long = llm.complete({ ...args, user: 'w '.repeat(600) })
    await assert.rejects(long, (err) => {
      assert.equal(err.code, 'TOO_LONG')
      assert.match(err.message, /1024-token context/)
      assert.match(err.message, /room for 448/)
      return true
    })
  } finally {
    mock().contextSize = 8192
  }
})
