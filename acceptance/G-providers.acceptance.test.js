/**
 * Group G — Providers and privacy.
 * Scenarios: acceptance/features/G-providers.feature. Run: npm run test:acceptance
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'

import { startApp } from './support/app.js'
import { BLOG_PROMPT, FIX_RESPONSE } from './support/fixtures.js'
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
beforeEach(() => stub.reset())

test('G1 — The app offers only providers that can actually work', async () => {
  const config = (await app.get('/api/config')).body
  const byId = Object.fromEntries(config.providers.map((p) => [p.id, p]))
  assert.equal(byId.compatible.configured, true)
  for (const id of ['anthropic', 'openai', 'openrouter', 'google', 'local']) {
    assert.equal(byId[id].configured, false, `${id} has no key or model`)
  }
  assert.equal(config.defaultProvider, 'compatible')

  const bare = await startApp()
  try {
    assert.equal((await bare.get('/api/config')).body.defaultProvider, 'local')
  } finally {
    await bare.stop()
  }
})

test('G2 — Keys never reach the browser', async () => {
  // app.raw() fails any response that contains the canary key; walk every route.
  await app.get('/api/health')
  await app.get('/api/config')
  await app.get('/api/examples')
  await app.get('/api/models?provider=compatible')
  await app.get('/api/models?provider=anthropic')
  await app.analyze(BLOG_PROMPT)
  await app.fix(BLOG_PROMPT)
  const echoing = { status: 500, message: 'invalid key ' + 'canary-compatible-key-7f3a' }
  stub.queue(echoing)
  const failed = await app.fix(BLOG_PROMPT) // an upstream error that echoes the key…
  assert.match(failed.body.error, /\[redacted\]/, '…is shown with the key blanked out')
  // …and the same echo inside a failed corrective retry, which rides in a 200 reply.
  stub.queue({ json: { ...FIX_RESPONSE, fixedPrompt: 'Write a concise markdown table with three rows.' } }, echoing)
  const warned = await app.fix('I changed the strgnth but it still changes a lot', { strength: 'light' })
  assert.equal(warned.status, 200)
  assert.match(warned.body.meta.warning, /retry also failed/)
  await app.get('/api/library')
  await app.post('/api/library', { original: 'a', fixed: 'b' })
  await app.get('/api/library/export')
  await app.post('/api/library/import', { nope: true })
  await app.del('/api/library/all')
  await app.get('/api/local/status')
  await app.post('/api/local/select', { tier: 'nope' })
  await app.post('/api/local/cancel')
  await app.get('/api/does-not-exist')
})

test('G3 — A client cannot redirect a keyed provider', async () => {
  const { status } = await app.fix(BLOG_PROMPT, {}, { baseUrl: 'http://127.0.0.1:1/nothing-here' })
  assert.equal(status, 200, 'the request still reached the configured endpoint')
  assert.equal(stub.requests.length, 1)

  const bad = await app.get(`/api/models?provider=ollama&baseUrl=${encodeURIComponent('ftp://evil.example')}`)
  assert.equal(bad.status, 400, 'a key-less endpoint override must still be http(s)')
})

test('G4 — Model lists are live where possible and honest where not', async () => {
  stub.models({ models: ['stub-large', 'stub-small'] })
  const live = await app.get('/api/models?provider=compatible')
  assert.deepEqual(live.body, { models: ['stub-large', 'stub-small'], source: 'live' })

  stub.models({ status: 401, message: 'invalid api key' })
  const rejected = await app.get('/api/models?provider=compatible')
  assert.ok(rejected.status === 401 || rejected.status === 403, `rejected key surfaces as ${rejected.status}`)
  assert.ok(rejected.body.error, 'with a message')
  assert.equal(rejected.body.models, undefined, 'and no fallback list hiding it')

  const missing = await app.get('/api/models?provider=anthropic')
  assert.ok(missing.status >= 400)
  assert.match(missing.body.error, /key/i, 'a missing key is named, not guessed around')
})

test('G5 — The journey is the same on every provider', { todo: 'nightly: needs the local model' }, () => {})

test('G6 — The API is reachable only from this machine', async () => {
  const foreign = await app.raw('GET', '/api/health', { headers: { origin: 'http://evil.example' } })
  assert.equal(foreign.headers.get('access-control-allow-origin'), null, 'a foreign origin is not granted access')

  const local = await app.raw('GET', '/api/health', { headers: { origin: 'http://localhost:5173' } })
  assert.equal(local.headers.get('access-control-allow-origin'), 'http://localhost:5173')

  const lookalike = await app.raw('GET', '/api/health', { headers: { origin: 'http://localhost.evil.example' } })
  assert.equal(lookalike.headers.get('access-control-allow-origin'), null, 'a lookalike origin does not pass')
})
