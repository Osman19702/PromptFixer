/**
 * Group A — Scoring a prompt, with no model involved.
 * Scenarios: acceptance/features/A-scoring.feature. Run: npm run test:acceptance
 *
 * The server here has no provider configured at all: scoring must work anyway.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { startApp } from './support/app.js'
import { BLOG_PROMPT, CODE_PROMPT, GOOD_PROMPT, IMAGE_PROMPT, TRANSCRIPT_PROMPT } from './support/fixtures.js'

let app
before(async () => {
  app = await startApp()
})
after(() => app.stop())

const SEVERITIES = ['high', 'medium', 'low']
const CATEGORIES = ['clarity', 'specificity', 'context', 'format', 'structure']
const ids = (analysis) => analysis.issues.map((i) => i.id)
const byId = (analysis, id) => analysis.issues.find((i) => i.id === id)

test('A1 — A pasted prompt is scored before anything is contacted', async () => {
  const config = (await app.get('/api/config')).body
  const configured = config.providers.filter((p) => p.configured)
  // Ollama counts as configured by its default URL; nothing with a key is, and the local model is absent.
  assert.ok(configured.every((p) => p.keyOptional && p.id !== 'local'), `configured: ${configured.map((p) => p.id)}`)

  const started = Date.now()
  const { status, body } = await app.analyze(BLOG_PROMPT)
  assert.equal(status, 200)
  assert.ok(Date.now() - started < 500, 'scoring is instant')
  const a = body.analysis
  assert.equal(typeof a.score, 'number')
  assert.match(a.grade, /^[A-F]$/)
  assert.deepEqual(Object.keys(a.categories).sort(), [...CATEGORIES].sort())
  assert.ok(a.issues.length > 0, 'a defective prompt has issues')
})

test('A2 — The same prompt always produces the same score', async () => {
  const one = (await app.analyze(BLOG_PROMPT, { intent: 'writing' })).body.analysis
  const two = (await app.analyze(BLOG_PROMPT, { intent: 'writing' })).body.analysis
  assert.deepEqual(one, two)
})

test('A3 — Every finding tells the user what to do about it', async () => {
  const a = (await app.analyze(BLOG_PROMPT)).body.analysis
  for (const issue of a.issues) {
    assert.ok(issue.title, `issue ${issue.id} has a title`)
    assert.ok(SEVERITIES.includes(issue.severity), `issue ${issue.id} has a severity`)
    assert.ok(CATEGORIES.includes(issue.category), `issue ${issue.id} has a category`)
    assert.ok(typeof issue.suggestion === 'string' && issue.suggestion.trim(), `issue ${issue.id} has a suggestion`)
  }
  const ranks = a.issues.map((i) => SEVERITIES.indexOf(i.severity))
  assert.deepEqual(ranks, [...ranks].sort((x, y) => x - y), 'ordered most severe first')
})

test('A4 — A small edit never swings the score wildly', async () => {
  const base = (await app.analyze(BLOG_PROMPT)).body.analysis.score
  const plusOne = (await app.analyze(`${BLOG_PROMPT} today`)).body.analysis.score
  assert.ok(Math.abs(base - plusOne) <= 5, `one neutral word moved the score by ${Math.abs(base - plusOne)}`)

  const withFiller = 'Write a really very detailed summary of the attached report in at most 200 words, as markdown bullets.'
  const without = withFiller.replace('really very ', '')
  const before = (await app.analyze(withFiller)).body.analysis.score
  const afterScore = (await app.analyze(without)).body.analysis.score
  assert.ok(afterScore >= before, `dropping filler scored ${afterScore} vs ${before}`)
})

test('A5 — A broken short prompt scores below a clean short prompt', async () => {
  // Fifteen words each: past the very-short ceiling, so quality can show.
  const clean = (await app.analyze('Summarize the attached quarterly report in three bullets for the finance team, under 100 words.')).body.analysis.score
  const broken = (await app.analyze('the thing with the report and stuff from before, maybe the numbers and so on')).body.analysis.score
  assert.ok(clean > broken + 10, `clean ${clean} should beat broken ${broken} clearly`)
})

test('A6 — The task type changes which findings apply', async () => {
  // Long enough (over 25 words) that an audience is expected of a general prompt.
  const prompt = `${CODE_PROMPT} Also explain what was wrong with the old version so the team learns from it.`
  const general = (await app.analyze(prompt, { intent: 'general' })).body.analysis
  const code = (await app.analyze(prompt, { intent: 'code' })).body.analysis
  assert.ok(byId(general, 'no-audience'), 'General asks for an audience')
  assert.ok(!byId(code, 'no-audience'), 'Code does not')
  assert.equal(byId(code, 'no-limits')?.severity, 'low', 'a scope limit is a nicety for code')
  assert.notEqual(general.issues.length, code.issues.length, 'the issue count visibly changes')
})

test('A7 — Code inside a prompt is not linted as if it were prose', async () => {
  const prompt = [
    'Refactor the function below so it handles empty input and return only the changed function.',
    '',
    '```js',
    '// WAIT!! REALLY REALLY BAD STUFF HERE, kind of nice though',
    'function go(stuff) { return stuff }',
    '```',
  ].join('\n')
  const a = (await app.analyze(prompt, { intent: 'code' })).body.analysis
  assert.ok(!byId(a, 'shouting'), 'the !! inside the fence is not shouting')
  const vague = byId(a, 'vague-terms')
  assert.ok(!vague || !vague.evidence?.some((w) => /stuff|nice|kind of/.test(w)), 'code words are not vague wording')
  assert.ok(a.stats.lines >= 6, 'structure still sees the whole prompt')
})

test('A8 — A prompt that refers to input it did not attach is a serious finding', async () => {
  const missing = (await app.analyze(TRANSCRIPT_PROMPT, { intent: 'analysis' })).body.analysis
  const finding = byId(missing, 'missing-input')
  assert.ok(finding, 'missing input is reported')
  assert.equal(finding.severity, 'high')
  assert.match(finding.suggestion, /delimit|```|<|block|fence|tag/i)

  const pasted = `${TRANSCRIPT_PROMPT}\n\nInterviewer: How do you use the app day to day?\nCustomer: Mostly on my phone, and it crashes every time I open the export screen.`
  const attached = (await app.analyze(pasted, { intent: 'analysis' })).body.analysis
  assert.ok(!byId(attached, 'missing-input'), 'material pasted below is not missing')
  const note = byId(attached, 'undelimited-input')
  assert.ok(!note || note.severity === 'low', 'at most a low structure note remains')
})

test('A9 — A descriptor-style image prompt is not punished for being one', async () => {
  const a = (await app.analyze(IMAGE_PROMPT, { intent: 'image' })).body.analysis
  for (const id of ['no-task-verb', 'no-role', 'no-format']) {
    assert.ok(!byId(a, id), `${id} must not fire on an image descriptor list`)
  }
})

test('A10 — A good prompt is told what it got right', async () => {
  const a = (await app.analyze(GOOD_PROMPT, { intent: 'analysis' })).body.analysis
  assert.equal(a.grade, 'A', `scored ${a.score}`)
  assert.ok(a.strengths.length >= 1, 'strengths are listed')
  assert.ok(!a.issues.some((i) => i.severity === 'high'), 'no high-severity complaints')
})

test('A11 — An oversized prompt is refused politely rather than hanging the app', async () => {
  const atLimit = 'a '.repeat(30_000) // exactly 60,000 characters
  const started = Date.now()
  const ok = await app.analyze(atLimit)
  assert.equal(ok.status, 200)
  assert.ok(Date.now() - started < 5000, 'the boundary case returns within budget')

  const over = `${atLimit}b`
  const refused = await app.analyze(over)
  assert.equal(refused.status, 413)
  assert.match(refused.body.error, /60001/)
  assert.match(refused.body.error, /60000/)
  const fixRefused = await app.post('/api/fix', { prompt: over, provider: 'local' })
  assert.equal(fixRefused.status, 413, 'the fix route refuses it the same way')
})

test('A12 — An empty editor is an empty state, not an error', async () => {
  const { status, body } = await app.analyze('')
  assert.equal(status, 200)
  assert.equal(body.analysis.empty, true)
  const whitespace = await app.analyze('   \n  ')
  assert.equal(whitespace.body.analysis.empty, true)
})
