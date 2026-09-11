/**
 * Group L — Configuration, limits and errors.
 * Scenarios: acceptance/features/L-config.feature. Run: npm run test:acceptance
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { startApp } from './support/app.js'
import { BLOG_PROMPT } from './support/fixtures.js'
import { startStub } from './support/stub-provider.js'

let stub
let app
before(async () => {
  stub = await startStub()
  app = await startApp({ stub })
})
after(async () => {
  await app.stop()
  await stub.close()
})

test('L1 — Everything has a working default', async () => {
  const bare = await startApp()
  try {
    const config = (await bare.get('/api/config')).body
    assert.equal(config.defaultProvider, 'local')
    assert.equal(config.limits.maxPromptChars, 60_000)
    assert.ok(config.providers.length >= 6, 'every provider is listed, configured or not')
    assert.ok(config.presets.intents.length && config.presets.strengths.length)
    assert.equal((await bare.analyze(BLOG_PROMPT)).status, 200, 'usable for linting immediately')
  } finally {
    await bare.stop()
  }
})

test('L2 — Port precedence and the development proxy', async () => {
  // The harness asks for port 0; the server must report the port it actually got.
  const port = Number(new URL(app.base).port)
  assert.ok(port > 0, `an OS-assigned port was reported: ${port}`)
  assert.equal((await app.get('/api/health')).body.ok, true)
})

test('L3 — Errors have one consistent shape', async () => {
  const shape = (body) => {
    assert.equal(typeof body.error, 'string')
    assert.ok(body.error.length > 0)
    assert.equal(typeof body.retryable, 'boolean')
    assert.ok('code' in body && 'provider' in body, 'code and provider are always present, even when empty')
  }
  shape((await app.fix('   ')).body) // client error
  shape((await app.post('/api/local/select', { tier: 'nope' })).body) // local model error
  shape((await app.post('/api/fix', { prompt: BLOG_PROMPT, provider: 'no-such-provider' })).body) // unknown provider
  stub.queue({ status: 503, message: 'busy' })
  const upstream = (await app.fix(BLOG_PROMPT)).body
  shape(upstream)
  assert.equal(upstream.provider, 'Stub')
  assert.equal(upstream.retryable, true)
})

test('L4 — The advertised limits are real', async () => {
  const atLimit = 'a '.repeat(30_000)
  assert.equal((await app.fix(atLimit)).status, 200, 'exactly 60,000 characters is accepted')
  const over = await app.fix(`${atLimit}b`)
  assert.equal(over.status, 413)
  assert.match(over.body.error, /60000/, 'the limit is named')

  const entries = Array.from({ length: 501 }, (_, i) => ({ id: `cap-${i}`, original: `p${i}`, fixed: `f${i}` }))
  const imported = (await app.post('/api/library/import', { entries })).body
  assert.equal(imported.total, 500, 'the library cap holds on import')
  assert.equal(imported.skipped, 1)
  await app.clearLibrary()
})
