/**
 * Group B — Fixing a prompt.
 * Scenarios: acceptance/features/B-fix.feature. Run: npm run test:acceptance
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'

import { startApp } from './support/app.js'
import { closeBrowser, launchBrowser, openApp, typePrompt, ui } from './support/browser.js'
import { BLOG_PROMPT, COMPLAINT, DIVERGENT, FIX_RESPONSE } from './support/fixtures.js'
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('B1 — The whole journey, end to end', async () => {
  const options = { intent: 'writing', strength: 'balanced' }
  const { status, body } = await app.fix(BLOG_PROMPT, options)
  assert.equal(status, 200)

  assert.equal(body.original, BLOG_PROMPT)
  assert.equal(body.fixedPrompt, FIX_RESPONSE.fixedPrompt)
  assert.equal(typeof body.summary, 'string')
  assert.ok(body.changes.length >= 1)
  for (const c of body.changes) assert.ok(c.what && c.why, 'each change has a what and a why')
  assert.ok(Array.isArray(body.assumptions) && Array.isArray(body.questions) && Array.isArray(body.techniques))

  // Before and after are measured with identical settings.
  const independent = (await app.analyze(BLOG_PROMPT, options)).body.analysis
  assert.deepEqual(body.before, independent, 'the before score is the score the user saw')
  assert.deepEqual(Object.keys(body.after.categories), Object.keys(body.before.categories))
  assert.ok(body.after.score > body.before.score, `${body.before.score} → ${body.after.score}`)

  assert.equal(body.meta.provider, 'compatible')
  assert.ok(body.meta.model, 'the model that answered is named')
  assert.equal(typeof body.meta.elapsedMs, 'number')
  assert.equal(body.meta.attempts, 1)
})

test('B2 — The rewrite addresses the problems the user was shown', async () => {
  const options = { intent: 'writing', strength: 'balanced' }
  const shown = (await app.analyze(BLOG_PROMPT, options)).body.analysis.issues.map((i) => i.title).sort()
  await app.fix(BLOG_PROMPT, options)
  const given = stub.last().findings.map((f) => f.title).sort()
  assert.deepEqual(given, shown, 'the model was handed exactly the findings the user saw')
})

test("B3 — The tool never invents facts about the user's situation", async () => {
  stub.queue({
    json: {
      ...FIX_RESPONSE,
      fixedPrompt:
        "Write a 300-word blog post announcing [product name]'s new feature for [target audience]. Use markdown with an H1 and three H2 sections.",
    },
  })
  const { body } = await app.fix(BLOG_PROMPT, { intent: 'writing' })
  const reminder = body.after.issues.find((i) => i.id === 'placeholders')
  assert.ok(reminder, 'the placeholder is still pointed out')
  assert.equal(reminder.severity, 'low', 'as a reminder, not a defect')

  const original = (await app.analyze("Write a post about [product name]'s launch for [target audience].")).body.analysis
  assert.equal(original.issues.find((i) => i.id === 'placeholders')?.severity, 'high', 'in an original it is a defect')
})

test('B4 — Failure has a face', async () => {
  stub.queue({ status: 500, message: 'internal explosion' })
  const { status, body } = await app.fix(BLOG_PROMPT)
  assert.ok(status >= 500 && status < 600)
  assert.equal(body.provider, 'Stub')
  assert.match(body.error, /Stub/)
  assert.doesNotMatch(body.error, /\n\s+at /, 'no stack trace')
  assert.doesNotMatch(body.error, /^\{/, 'no raw JSON')
  assert.equal(body.retryable, true)
})

test('B5 — A fix can be cancelled and the machine is handed back', async () => {
  // A divergent light-touch reply would normally trigger a corrective retry.
  stub.queue({ delayMs: 800, json: DIVERGENT }, { json: DIVERGENT })
  const controller = new AbortController()
  // The browser's cancel is a fetch abort; do the same, mid-generation.
  const raw = app.raw('POST', '/api/fix', {
    body: { prompt: COMPLAINT, provider: 'compatible', model: 'stub-large', options: { strength: 'light' } },
    signal: controller.signal,
  })
  // Cancel once generation is genuinely under way, not while the server is still preparing.
  const started = Date.now()
  while (stub.requests.length === 0 && Date.now() - started < 3000) await sleep(20)
  controller.abort()
  await raw.catch(() => {})
  await sleep(1200)
  assert.equal(stub.requests.length, 1, 'no corrective retry followed the cancelled attempt')
  assert.equal(stub.requests[0].upstreamAborted, true, 'the server abandoned its upstream request')
})

test('B6 — A stalled provider gives up in bounded time', async () => {
  const slow = await startApp({ stub, env: { PROVIDER_TIMEOUT_MS: '400' } })
  try {
    stub.queue({ stall: 'headers' })
    const headers = await slow.fix(BLOG_PROMPT)
    assert.equal(headers.status, 502)
    assert.match(headers.body.error, /timed out/)
    assert.equal(headers.body.retryable, true)

    stub.queue({ stall: 'body' })
    const body = await slow.fix(BLOG_PROMPT)
    assert.equal(body.status, 502)
    assert.match(body.body.error, /timed out/)
    assert.equal(body.body.retryable, true)
  } finally {
    await slow.stop()
  }
})

test('B7 — A truncated reply is reported as a truncated reply', async () => {
  stub.queue({ json: FIX_RESPONSE, finishReason: 'length' })
  const { status, body } = await app.fix(BLOG_PROMPT)
  assert.equal(status, 502)
  assert.match(body.error, /cut off/)
  assert.match(body.error, /try again/)
  assert.doesNotMatch(body.error, /malformed|JSON|parse/i)
  assert.equal(body.retryable, true)
})

test('B8 — Nonsense from the client is coerced, never a server error', async () => {
  for (const options of ['x', [], null, 42, { foo: 1, intent: { nested: true } }]) {
    const a = await app.post('/api/analyze', { prompt: BLOG_PROMPT, options })
    assert.ok(a.status < 500, `analyze with options=${JSON.stringify(options)} gave ${a.status}`)
    const f = await app.post('/api/fix', { prompt: BLOG_PROMPT, provider: 'compatible', options })
    assert.ok(f.status < 500, `fix with options=${JSON.stringify(options)} gave ${f.status}`)
  }
  const repeated = await app.get('/api/models?provider=compatible&baseUrl=a&baseUrl=b')
  assert.ok(repeated.status < 500, 'repeated query params are not a server error')
  const notJson = await app.raw('POST', '/api/analyze', { body: undefined, headers: {} })
  assert.ok(notJson.status < 500, 'a missing body is not a server error')
})

test('B9 — An empty prompt is refused before any model is contacted', async () => {
  const { status, body } = await app.fix('   \n\t ')
  assert.equal(status, 400)
  assert.match(body.error, /no prompt/i)
  assert.equal(stub.requests.length, 0, 'the provider was never called')
})

test('B10 — The last ten fixes stay comparable', async () => {
  await launchBrowser()
  const { page, close } = await openApp(app)
  try {
    // Each rewrite keeps the prompt's words so the guard accepts it first time;
    // a divergent reply would trigger a retry and swallow the next queued one.
    for (let n = 1; n <= 12; n++) {
      stub.queue({
        json: {
          ...FIX_RESPONSE,
          fixedPrompt: `${BLOG_PROMPT} Rewrite number ${n}.`,
          summary: `Summary number ${n}.`,
          changes: [{ type: 'format', what: `Change number ${n}`, why: 'To tell the fixes apart.' }],
        },
      })
    }
    await typePrompt(page, BLOG_PROMPT)
    for (let n = 1; n <= 12; n++) {
      await ui.fixButton(page).click()
      await page.locator('pre.output', { hasText: `Rewrite number ${n}.` }).waitFor()
    }
    assert.equal(await ui.historyCount(page).innerText(), '10 of 10', 'only the last ten are kept')
    assert.equal(await ui.next(page).isDisabled(), true, 'clamped at the newest')

    for (let i = 0; i < 9; i++) await ui.prev(page).click()
    assert.equal(await ui.historyCount(page).innerText(), '1 of 10')
    assert.equal(await ui.prev(page).isDisabled(), true, 'clamped at the oldest')
    assert.match(await ui.output(page).innerText(), /Rewrite number 3\.$/, 'the oldest kept is the third fix')
    await page.locator('.banner', { hasText: 'Summary number 3.' }).waitFor()
    await ui.tab(page, 'Changes').click()
    await page.locator('.pane-body', { hasText: 'Change number 3' }).waitFor()
    await ui.tab(page, 'Diff').click()
    assert.match(await page.locator('.pane-body').nth(1).innerText(), /number 3/, 'the Diff tab follows too')

    await ui.next(page).click()
    assert.equal(await ui.historyCount(page).innerText(), '2 of 10')
    await ui.tab(page, 'Fixed').click()
    assert.match(await ui.output(page).innerText(), /Rewrite number 4\.$/)
  } finally {
    await close()
    await closeBrowser()
  }
})
