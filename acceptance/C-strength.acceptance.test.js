/**
 * Group C — The strength contract and the rewrite guard.
 * Scenarios: acceptance/features/C-strength.feature. Run: npm run test:acceptance
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'

import { startApp } from './support/app.js'
import { BLOG_PROMPT, COMPLAINT, DIVERGENT, bloated, leaked, typoFix, unchanged } from './support/fixtures.js'
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

/** Findings that can only be satisfied by adding material the user did not write. */
const ADDITIVE = new Set([
  'no-context',
  'no-audience',
  'no-format',
  'no-limits',
  'no-criteria',
  'no-examples',
  'no-role',
  'ungrounded-facts',
])

const light = (prompt) => app.fix(prompt, { strength: 'light' })

test("C1 — Strength is a promise about the user's own words", async () => {
  const floors = {}
  for (const strength of ['light', 'balanced', 'aggressive']) {
    const { body } = await app.fix(BLOG_PROMPT, { strength })
    floors[strength] = body.meta.minRetention
  }
  assert.deepEqual(floors, { light: 0.6, balanced: 0.3, aggressive: 0 })

  const presets = (await app.get('/api/config')).body.presets
  assert.deepEqual(
    presets.strengths.map((s) => s.id),
    ['light', 'balanced', 'aggressive']
  )
  for (const s of presets.strengths) assert.ok(s.label, `${s.id} has a label the user can read`)
})

test("C2 — A Light touch rewrite that throws the user's words away is retried, and the faithful attempt is kept", async () => {
  stub.queue({ json: DIVERGENT }, typoFix)
  const { status, body } = await light(COMPLAINT)
  assert.equal(status, 200)
  assert.equal(body.fixedPrompt, 'I changed the strength but it still changes a lot.')
  assert.equal(body.meta.attempts, 2)
  assert.equal(body.meta.warning, undefined, 'a successful retry is not a warning')
  assert.ok(body.meta.retention >= 0.6)

  const retry = stub.requests[1]
  assert.equal(retry.isRetry, true)
  assert.match(retry.rejectedReasons, /words survived/, 'the retry was told why')
  assert.equal(retry.original, COMPLAINT, 'the retry still edits the original, not the rejected attempt')
})

test('C3 — When both attempts overshoot, the user is warned and still gets the better one', async () => {
  stub.queue({ json: DIVERGENT }, { json: DIVERGENT })
  const { status, body } = await light(COMPLAINT)
  assert.equal(status, 200)
  assert.equal(body.fixedPrompt, DIVERGENT.fixedPrompt, 'the user still gets a result')
  assert.equal(body.meta.warningKind, 'retention')
  assert.match(body.meta.warning, /Light touch/)
  assert.match(body.meta.warning, /\d+% of your words/)
  assert.match(body.meta.warning, /try Balanced/)
  assert.doesNotMatch(body.meta.warning, /try Light touch/, 'never advise the strength they are on')

  stub.queue({ json: DIVERGENT }, { json: DIVERGENT })
  const balanced = (await app.fix(COMPLAINT, { strength: 'balanced' })).body
  if (balanced.meta.warning) assert.doesNotMatch(balanced.meta.warning, /try Balanced/)
})

test('C4 — Light touch is never asked to do the impossible', async () => {
  const analysis = (await app.analyze(BLOG_PROMPT)).body.analysis
  const additiveTitles = analysis.issues.filter((i) => ADDITIVE.has(i.id)).map((i) => i.title)
  assert.ok(additiveTitles.length >= 2, 'the fixture prompt has additive findings to withhold')

  await light(BLOG_PROMPT)
  const shownAtLight = stub.last().findings.map((f) => f.title)
  for (const t of additiveTitles) assert.ok(!shownAtLight.includes(t), `Light touch was shown "${t}"`)
  assert.ok(!stub.last().findings.some((f) => f.severity === 'low'), 'nor low-priority nitpicks')

  await app.fix(BLOG_PROMPT, { strength: 'balanced' })
  const shownAtBalanced = stub.last().findings.map((f) => f.title)
  for (const t of additiveTitles) assert.ok(shownAtBalanced.includes(t), `Balanced should see "${t}"`)
})

test('C5 — Keeping every word and bolting scaffolding onto it is also a violation', async () => {
  stub.queue(bloated, bloated)
  const { body } = await light(COMPLAINT)
  assert.equal(body.meta.attempts, 2)
  assert.equal(body.meta.warningKind, 'growth')
  assert.match(body.meta.warning, /added more/)
  assert.doesNotMatch(body.meta.warning, /words survived/, 'the growth warning is not the retention warning')
  assert.match(stub.requests[1].rejectedReasons, /scaffolding/, 'the retry was told it grew, not that it diverged')
})

test('C6 — Full rebuild is genuinely unbounded', async () => {
  stub.queue({ json: DIVERGENT })
  const { body } = await app.fix(COMPLAINT, { strength: 'aggressive' })
  assert.equal(body.fixedPrompt, DIVERGENT.fixedPrompt)
  assert.equal(body.meta.warning, undefined)
  assert.equal(body.meta.attempts, 1)
  assert.equal(body.meta.minRetention, 0)
})

test("C7 — The tool's own instructions never reach the user", async () => {
  stub.queue(leaked, leaked)
  const { status, body } = await light(COMPLAINT)
  assert.equal(status, 200)
  assert.equal(body.meta.warningKind, 'leak')
  assert.match(body.meta.warning, /check the result carefully/)
  assert.ok(body.fixedPrompt.trim().length > 0, 'never an empty rewrite')
  assert.doesNotMatch(body.fixedPrompt, /STRENGTH: LIGHT TOUCH|linter_findings|Return the JSON/)
  assert.match(body.fixedPrompt, /I changed the strength but it still changes a lot/, "the user's line survives")
})

test("C8 — A user's own finding-shaped text is not mistaken for our boilerplate", async () => {
  const prompt = [
    'Review the findings below from our prompt linter and tell me which two to fix first.',
    '',
    '- [high/clarity] No clear action requested: the prompt never says what to do.',
    '- [medium/format] No output format: nothing says how the answer should look.',
    '- [low/structure] No role set: no persona is given.',
  ].join('\n')
  stub.queue((r) => ({ ...unchanged(r), fixedPrompt: r.original.replace('tell me', 'say') }))
  const { body } = await light(prompt)
  assert.equal(body.meta.warning, undefined, `unexpected warning: ${body.meta.warning}`)
  assert.match(body.fixedPrompt, /\[high\/clarity\]/, 'the finding-shaped line is still theirs')
  assert.equal(body.meta.attempts, 1)
})

test('C9 — When two attempts both fall short, the choice between them is predictable', async () => {
  stub.queue({ json: DIVERGENT }, leaked)
  const first = (await light(COMPLAINT)).body
  assert.equal(first.fixedPrompt, DIVERGENT.fixedPrompt, 'divergent beats leaked')
  assert.equal(first.meta.warningKind, 'retention')

  stub.queue(leaked, { json: DIVERGENT })
  const second = (await light(COMPLAINT)).body
  assert.equal(second.fixedPrompt, DIVERGENT.fixedPrompt, 'in either order')
  assert.equal(second.meta.warningKind, 'retention')
})

test('C10 — A failed corrective retry never becomes a server error', async () => {
  stub.queue({ json: DIVERGENT }, { status: 502, contentType: 'text/html', body: '<html>Bad gateway</html>' })
  const { status, body } = await light(COMPLAINT)
  assert.equal(status, 200)
  assert.equal(body.fixedPrompt, DIVERGENT.fixedPrompt, 'the first attempt is still the answer')
  assert.equal(body.meta.attempts, 2)
  assert.match(body.meta.warning, /corrective retry also failed/)
})
