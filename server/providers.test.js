/**
 * Provider adapter contract: base-URL policy, deadlines, cancellation,
 * truncation and the live-vs-fallback model list. Everything talks to local
 * http stubs on OS-assigned ports; no network, no native module.
 * Run with: npm test
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

// An empty model dir so the local provider reports "not downloaded" whatever
// this machine has under ~/.promptfixer.
const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptfixer-providers-models-'))
process.env.PROMPTFIXER_MODEL_DIR = modelDir
process.env.PROMPTFIXER_MODEL = 'default'
process.env.OPENAI_API_KEY = 'sk-test-must-not-leak'
process.env.COMPATIBLE_API_KEY = ''

/** A stub whose behaviour is chosen per request by the `mode` the test sets. */
function startStub() {
  const stub = {
    server: null,
    port: 0,
    url: '',
    mode: 'ok',
    requests: [],
    sockets: new Set(),
  }
  stub.server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      stub.requests.push({ url: req.url, headers: req.headers, body })
      if (stub.mode === 'stall') {
        // Headers plus half a body, then silence: the case the deadline missed.
        res.writeHead(200, { 'content-type': 'application/json' })
        res.write('{"choices":[{"message":{"content":"')
        return
      }
      if (stub.mode === 'unauthorized') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }))
        return
      }
      if (stub.mode === 'outage') {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'overloaded' } }))
        return
      }
      if (req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'stub-a' }, { id: 'stub-b' }] }))
        return
      }
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ models: [{ name: 'llama-stub' }] }))
        return
      }
      const truncated = stub.mode === 'truncate'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          model: 'stub-model',
          choices: [
            {
              finish_reason: truncated ? 'length' : 'stop',
              message: { content: truncated ? '{"fixedPrompt":"Write a long bl' : '{"fixedPrompt":"ok"}' },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      )
    })
  })
  stub.server.on('connection', (socket) => {
    stub.sockets.add(socket)
    socket.on('close', () => stub.sockets.delete(socket))
  })
  return new Promise((resolve) => {
    stub.server.listen(0, '127.0.0.1', () => {
      stub.port = stub.server.address().port
      stub.url = `http://127.0.0.1:${stub.port}`
      resolve(stub)
    })
  })
}

const stopStub = (stub) =>
  new Promise((resolve) => {
    for (const s of stub.sockets) s.destroy()
    stub.server.close(() => resolve())
  })

let primary // the env-configured endpoint
let rogue // an attacker-chosen endpoint; must never see a keyed request
let providers
let llm

before(async () => {
  primary = await startStub()
  rogue = await startStub()
  process.env.COMPATIBLE_BASE_URL = primary.url
  providers = await import('./providers.js')
  llm = await import('./local-llm.js')
})

after(async () => {
  await stopStub(primary)
  await stopStub(rogue)
  fs.rmSync(modelDir, { recursive: true, force: true })
})

const args = { system: 'sys', user: 'user', temperature: 0.3, maxTokens: 4000, jsonMode: true }

// --- base URL policy (finding 16) --------------------------------------------

test('a request-supplied baseUrl is ignored for a provider that carries an API key', async () => {
  const { resolveConfig, PROVIDERS } = providers
  const cfg = resolveConfig('openai', { baseUrl: `${rogue.url}/exfil` })
  assert.equal(cfg.baseUrl, PROVIDERS.openai.baseUrl)
  assert.equal(cfg.apiKey, 'sk-test-must-not-leak')

  // Same for the compatible endpoint once a key is set for it: the override is
  // only for key-less local servers, so the key can never travel elsewhere.
  process.env.COMPATIBLE_API_KEY = 'compat-secret'
  try {
    await providers.listModels('compatible', { baseUrl: rogue.url })
  } finally {
    process.env.COMPATIBLE_API_KEY = ''
  }
  assert.equal(rogue.requests.length, 0, 'the rogue host must not receive any request')
  assert.ok(primary.requests.some((r) => r.headers.authorization === 'Bearer compat-secret'))
})

test('key-less local endpoints still accept an http(s) baseUrl override, validated', async () => {
  const { resolveConfig, ProviderError } = providers
  assert.equal(resolveConfig('ollama', { baseUrl: rogue.url }).baseUrl, rogue.url)
  assert.equal(resolveConfig('compatible', { baseUrl: rogue.url }).baseUrl, rogue.url)
  // Env base URLs keep working when no override is given.
  assert.equal(resolveConfig('compatible').baseUrl, primary.url)
  process.env.OLLAMA_BASE_URL = 'http://ollama.internal:11434'
  try {
    assert.equal(resolveConfig('ollama').baseUrl, 'http://ollama.internal:11434')
  } finally {
    delete process.env.OLLAMA_BASE_URL
  }
  // Non-strings (qs arrays/objects) are ignored, malformed strings are a 400.
  assert.equal(resolveConfig('compatible', { baseUrl: ['a', 'b'] }).baseUrl, primary.url)
  assert.throws(() => resolveConfig('ollama', { baseUrl: 'not a url' }), (err) => {
    assert.ok(err instanceof ProviderError)
    assert.equal(err.status, 400)
    return true
  })
  assert.throws(() => resolveConfig('ollama', { baseUrl: 'ftp://host/x' }), /http\(s\)/)
})

// --- deadline and cancellation (finding 18) ----------------------------------

test('the timeout covers a stalled response body, not just the headers', async () => {
  primary.mode = 'stall'
  process.env.PROVIDER_TIMEOUT_MS = '300'
  const started = Date.now()
  try {
    await assert.rejects(providers.complete('compatible', { model: 'stub-model' }, args), (err) => {
      assert.equal(err.name, 'ProviderError')
      assert.match(err.message, /timed out after 0\.3s/)
      assert.equal(err.retryable, true)
      return true
    })
  } finally {
    primary.mode = 'ok'
    delete process.env.PROVIDER_TIMEOUT_MS
  }
  assert.ok(Date.now() - started < 5_000, 'must fail at the deadline, not hang')
})

test('complete() honours an AbortSignal from the caller', async () => {
  primary.mode = 'stall'
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 50)
  try {
    await assert.rejects(providers.complete('compatible', { model: 'stub-model' }, { ...args, signal: controller.signal }), (err) => {
      assert.equal(err.name, 'ProviderError')
      assert.match(err.message, /cancelled/)
      assert.equal(err.retryable, false)
      return true
    })
  } finally {
    primary.mode = 'ok'
  }
})

// --- truncation (finding 46) -------------------------------------------------

test('a reply cut off at the output limit is a retryable ProviderError, not a JSON failure', async () => {
  primary.mode = 'truncate'
  try {
    await assert.rejects(providers.complete('compatible', { model: 'stub-model' }, args), (err) => {
      assert.equal(err.name, 'ProviderError')
      assert.match(err.message, /cut off at the 4000-token output limit/)
      assert.equal(err.retryable, true)
      assert.equal(err.status, 502)
      return true
    })
  } finally {
    primary.mode = 'ok'
  }
  const fine = await providers.complete('compatible', { model: 'stub-model' }, args)
  assert.equal(fine.finishReason, 'stop')
  assert.equal(fine.text, '{"fixedPrompt":"ok"}')
})

// --- model list (finding 22) -------------------------------------------------

test('listModels surfaces a rejected key instead of hiding it behind the fallback list', async () => {
  const { PROVIDERS } = providers
  // Point the keyed provider at the stub for this test only: its real host is
  // fixed on purpose (see the base URL policy above).
  const realBase = PROVIDERS.openai.baseUrl
  PROVIDERS.openai.baseUrl = primary.url
  try {
    primary.mode = 'unauthorized'
    await assert.rejects(providers.listModels('openai'), (err) => {
      assert.equal(err.status, 401)
      assert.match(err.message, /Incorrect API key/)
      return true
    })
    // A transient outage still degrades to the fallback list.
    primary.mode = 'outage'
    const degraded = await providers.listModels('openai')
    assert.equal(degraded.source, 'fallback')
    assert.deepEqual(degraded.models, PROVIDERS.openai.models)
  } finally {
    primary.mode = 'ok'
    PROVIDERS.openai.baseUrl = realBase
  }
})

// --- local provider follows the live tier (finding 21) -----------------------

test('the local provider lists and resolves the tier selected at runtime', async () => {
  const { PROVIDERS, resolveConfig, providerStatus } = providers
  assert.equal(PROVIDERS.local.models[0], 'default')
  llm.selectTier('lite')
  try {
    assert.equal(PROVIDERS.local.models[0], 'lite')
    assert.deepEqual([...PROVIDERS.local.models].sort(), ['default', 'lite', 'quality'])
    assert.equal(resolveConfig('local').model, 'lite')
    // A fix without a model must run on the selected tier, not flip it back.
    await assert.rejects(providers.complete('local', {}, { ...args, maxTokens: 2048 }), /Qwen2\.5 1\.5B Instruct/)
    assert.equal(llm.getStatus().tier, 'lite')
    assert.equal(providerStatus().find((p) => p.id === 'local').configured, false)
  } finally {
    llm.selectTier('default')
  }
  assert.equal(PROVIDERS.local.models[0], 'default')
})
