/**
 * Group F — The local model.
 * Scenarios: acceptance/features/F-local-model.feature. Run: npm run test:acceptance
 *
 * Only the scenarios that need no model file run here; the rest are nightly
 * on the GPU machine and are listed as todo so the gap is visible.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { startApp } from './support/app.js'
import { BLOG_PROMPT } from './support/fixtures.js'

const NIGHTLY = 'nightly on the GPU machine: needs a model file'

let app
before(async () => {
  app = await startApp()
})
after(() => app.stop())

test('F1 — A first-run user with no model is told exactly what to do', async () => {
  const status = (await app.get('/api/local/status')).body
  assert.equal(status.phase, 'missing')
  assert.equal(status.downloaded, false)
  assert.ok(status.model.label, 'the model is named')
  assert.ok(status.model.bytes > 500_000_000, 'and its size is known')
  assert.equal(status.catalog.length, 3, 'every tier is listed')
  for (const tier of status.catalog) assert.equal(tier.downloaded, false)

  const fix = await app.post('/api/fix', { prompt: BLOG_PROMPT, provider: 'local' })
  assert.ok(fix.status >= 400, 'a fix cannot succeed')
  assert.equal(fix.body.code, 'MODEL_MISSING')
  assert.match(fix.body.error, /download|not downloaded|missing/i, 'and the reason is the model, not a generic failure')

  const lint = await app.analyze(BLOG_PROMPT)
  assert.equal(lint.status, 200, 'linting works regardless')
})

test('F2 — The download is visible, resumable and cancellable', { todo: NIGHTLY }, () => {})
test('F3 — A download that produced no usable file says so', { todo: NIGHTLY }, () => {})

test('F4 — The machine picks a sensible model on its own', async () => {
  const chosen = await startApp({ env: { PROMPTFIXER_MODEL: 'lite' } })
  try {
    const status = (await chosen.get('/api/local/status')).body
    assert.equal(status.tier, 'lite', 'an explicit choice always wins')
  } finally {
    await chosen.stop()
  }
  const auto = (await app.get('/api/local/status')).body
  assert.ok(['lite', 'default'].includes(auto.tier), `the automatic pick is a real tier: ${auto.tier}`)
})

test('F5 — Switching models is safe at any moment', async () => {
  const bad = await app.post('/api/local/select', { tier: 'enormous' })
  assert.ok(bad.status >= 400)
  assert.equal(bad.body.code, 'BAD_TIER')
  assert.match(bad.body.error, /enormous/)

  const ok = await app.post('/api/local/select', { tier: 'quality' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.tier, 'quality')
  assert.equal(ok.body.phase, 'missing', 'the new tier is not on disk either')
  await app.post('/api/local/select', { tier: 'default' })
})

test('F6 — Loading is never confused about which model it is loading', { todo: NIGHTLY }, () => {})
test('F7 — The GPU is used when it exists and its absence is not a failure', { todo: NIGHTLY }, () => {})
test('F8 — A prompt too long for the model is refused with advice, not truncated', { todo: NIGHTLY }, () => {})
test('F9 — The result is always structurally valid', { todo: NIGHTLY }, () => {})
test('F10 — Quitting releases the model', { todo: 'desktop tier, nightly' }, () => {})
test('F11 — Nothing leaves the machine', { todo: 'manual charter: physically disconnected network' }, () => {})
