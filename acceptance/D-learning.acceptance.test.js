/**
 * Group D — Learning from the user's own library.
 * Scenarios: acceptance/features/D-learning.feature. Run: npm run test:acceptance
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'

import { startApp } from './support/app.js'
import { BLOG_PROMPT, DIVERGENT, FIX_RESPONSE, libraryEntry, parrotsExample, typoFix } from './support/fixtures.js'
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
beforeEach(async () => {
  stub.reset()
  await app.clearLibrary()
})

const save = (over) => app.post('/api/library', libraryEntry(over))
const writing = { intent: 'writing', strength: 'balanced' }

test('D1 — The tool learns how much change this user actually likes', async () => {
  const saved = (await save()).body.entry
  const { body } = await app.fix(BLOG_PROMPT, writing)
  const shown = stub.last()
  assert.equal(shown.examples, 1, 'one example was shown')
  assert.equal(shown.exampleTexts[0], saved.original)
  assert.equal(shown.exampleAfters[0], saved.fixed)
  assert.equal(body.meta.examplesUsed, 1, 'and the user is told so')
})

test('D2 — Only examples worth imitating are used', async () => {
  await save({ scoreBefore: 80, scoreAfter: 70 })
  await app.fix(BLOG_PROMPT, writing)
  assert.equal(stub.last().examples, 0, 'a rewrite that did not improve is not an example')

  await app.clearLibrary()
  await save({ original: BLOG_PROMPT, fixed: FIX_RESPONSE.fixedPrompt, scoreBefore: 60, scoreAfter: 92 })
  const { body } = await app.fix(BLOG_PROMPT, writing)
  assert.equal(stub.last().examples, 0, 'the prompt is never its own example')
  assert.equal(body.meta.examplesUsed, 0)
})

test('D3 — The same task type is preferred', async () => {
  const shared = 'write a blog post about our pricing page, make it good'
  await save({ original: shared, fixed: 'CODE-STYLE REWRITE', options: { intent: 'code' } })
  await save({ original: shared, fixed: 'WRITING-STYLE REWRITE', options: { intent: 'writing' } })
  await app.fix(BLOG_PROMPT, writing)
  assert.equal(stub.last().exampleAfters[0], 'WRITING-STYLE REWRITE', 'the matching task type ranks first')
})

test('D4 — The user can turn it off, and it never costs anything', async () => {
  await save()
  const { body } = await app.fix(BLOG_PROMPT, { ...writing, fewShot: false })
  assert.equal(stub.last().examples, 0)
  assert.equal(body.meta.examplesUsed, 0)
  assert.equal(stub.requests.length, 1, 'the only network call is the model itself')
})

test('D5 — A retry sees the same examples as the first attempt', async () => {
  await save()
  stub.queue({ json: DIVERGENT }, typoFix)
  const { body } = await app.fix(BLOG_PROMPT, { intent: 'writing', strength: 'light' })
  assert.equal(body.meta.attempts, 2)
  assert.equal(stub.requests[0].examples, 1)
  assert.equal(stub.requests[1].examples, 1)
  assert.deepEqual(stub.requests[1].exampleTexts, stub.requests[0].exampleTexts)
})

test('D6 — A rewrite that parrots an example back is caught', async () => {
  const saved = (await save()).body.entry
  stub.queue(parrotsExample, parrotsExample)
  const { status, body } = await app.fix(BLOG_PROMPT, writing)
  assert.equal(status, 200)
  assert.equal(body.meta.warningKind, 'leak', `got ${body.meta.warningKind}: ${body.meta.warning}`)
  assert.notEqual(body.fixedPrompt, saved.original, "the example's text is not returned as the user's rewrite")
})
