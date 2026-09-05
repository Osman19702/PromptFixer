/**
 * Unit tests for the deterministic linter (server/analyze.js).
 * No server, no model: analyzePrompt is pure.
 * Run with: npm test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { analyzePrompt } from './analyze.js'

const ids = (text, options) => analyzePrompt(text, options).issues.map((i) => i.id)
const issue = (text, id, options) => analyzePrompt(text, options).issues.find((i) => i.id === id)

// --- task verbs -------------------------------------------------------------

test('no-task-verb recognises inflected forms and the common request verbs', () => {
  const clear = [
    'Give me five ideas for a birthday party for a ten year old who loves dinosaurs and space.',
    'I need help writing a cover letter for a junior developer role at a fintech startup.',
    'Help me understand how garbage collection works in the JVM, for a mid-level Java developer.',
    'Return only a JSON object with keys name and email extracted from the message below.',
    'Writing a plan to build a treehouse for two kids, listing materials and steps in order.',
    'Show me how the pagination in this endpoint could be made cursor based instead of offset based.',
    'Summarizing the attached transcript is the goal: three bullets for the product channel.',
  ]
  for (const t of clear) {
    assert.ok(!ids(t).includes('no-task-verb'), t)
  }
  // A prompt with no recognisable instruction still gets the finding.
  assert.equal(issue('do the thing', 'no-task-verb')?.severity, 'high')
  assert.equal(issue('the quarterly numbers and the roadmap', 'no-task-verb')?.severity, 'high')
})

test('multi-task counts instruction verbs, not nouns that share the spelling', () => {
  // design, document, test, build and plan are all nouns here: one real ask plus a fix.
  const nouns =
    'Review the design document and fix the failing test in the build so the release plan is unblocked.'
  assert.ok(!ids(nouns).includes('multi-task'), ids(nouns).join(', '))

  const four =
    'Summarize the article, translate the summary into French, list three follow-up questions, and draft a reply email.'
  const found = issue(four, 'multi-task')
  assert.equal(found?.severity, 'medium')
  assert.deepEqual(found.evidence, ['summarize', 'translate', 'list', 'draft'])
})

// --- image intent -----------------------------------------------------------

test('an image prompt rewritten as a descriptor list is not punished for lacking a verb, role or format', () => {
  const before =
    'Create a picture of a cat sitting on a windowsill at sunset, make it look really nice and professional please.'
  const after =
    'cinematic photograph, tabby cat sitting on a wooden windowsill, golden-hour sunset backlight, warm orange and pink sky, soft rim lighting on fur, shallow depth of field, 85mm lens, f/1.8, high detail, no text, no watermark'
  const scored = analyzePrompt(after, { intent: 'image' })
  assert.ok(
    scored.score >= analyzePrompt(before, { intent: 'image' }).score,
    'a rewrite that follows the image guidance must not score below the original'
  )
  for (const id of ['no-task-verb', 'no-role', 'no-format', 'no-audience', 'no-criteria', 'run-on']) {
    assert.ok(!scored.issues.some((i) => i.id === id), `image intent must skip ${id}`)
  }
  // The skip is the intent, not the text: the same descriptor list linted as
  // a general prompt is still missing an instruction.
  assert.ok(ids(after, { intent: 'general' }).includes('no-task-verb'))
  // Findings that are still useful for an image prompt survive.
  assert.ok(ids(before, { intent: 'image' }).includes('vague-terms'))
})

// --- referenced input -------------------------------------------------------

test('pasted input right below the instruction is a low structure note, not missing context', () => {
  const pasted =
    'Summarize the text below in three sentences for a general reader.\n\nThe committee met on Tuesday to discuss the budget shortfall. Several members proposed cutting the travel allowance, while others argued for a hiring freeze. No decision was reached, and the chair scheduled a follow-up for next week.'
  const scored = analyzePrompt(pasted)
  assert.equal(scored.issues.find((i) => i.id === 'missing-input'), undefined)
  const note = scored.issues.find((i) => i.id === 'undelimited-input')
  assert.equal(note?.severity, 'low')
  assert.equal(note.category, 'structure')
  assert.ok(scored.categories.context >= 60, `context ${scored.categories.context}`)

  // Nothing follows the reference: the input really is missing.
  assert.equal(issue('Summarize the text below in three sentences.', 'missing-input')?.severity, 'high')
  // A tag pair is a delimiter, so neither finding fires.
  const tagged = 'Summarize the text below in three sentences.\n<document>\nThe committee met on Tuesday.\n</document>'
  assert.ok(!ids(tagged).some((id) => id === 'missing-input' || id === 'undelimited-input'))
})

test('the delimiter check is linear in the size of the prompt', () => {
  const hostile = 'the text below ' + '<a> '.repeat(62500)
  const started = Date.now()
  analyzePrompt(hostile)
  const elapsed = Date.now() - started
  assert.ok(elapsed < 1000, `took ${elapsed} ms`)
})

// --- wording rules skip code and markdown syntax --------------------------

test('wording rules ignore fenced code, inline code and markdown tokens', () => {
  const code =
    'Fix the bug in this function so it handles empty input without throwing, and return only the corrected code.\n\n```js\nfunction parse(input) {\n  // TODO: handle empty input\n  const MAX_SIZE = 100\n  const label = "good stuff"\n  return input.split(",").slice(0, MAX_SIZE)\n}\n```'
  const codeIds = ids(code, { intent: 'code' })
  for (const id of ['placeholders', 'shouting', 'vague-terms']) {
    assert.ok(!codeIds.includes(id), `${id} must not fire on code: ${codeIds.join(', ')}`)
  }
  assert.ok(analyzePrompt(code, { intent: 'code' }).categories.clarity >= 90)

  const inline = 'Rename the `TODO_LIST` constant to `PENDING_ITEMS` in every file and return only the diff.'
  assert.ok(!ids(inline, { intent: 'code' }).includes('placeholders'))

  const checklist =
    'Write release notes for the sprint. Done so far:\n- [x] migrated the database\n- [x] added the export button\n- [ ] fixed the login bug'
  assert.ok(!ids(checklist).includes('placeholders'))

  const acronyms =
    'Convert this CSV to JSON and validate it against the XML schema, then emit YAML and HTML for the API docs. Return only the files.'
  assert.ok(!ids(acronyms, { intent: 'code' }).includes('shouting'))

  // Real shouting and real placeholders in the prose still count.
  const loud = 'FIX [insert topic] NOW!! SERIOUSLY I NEED THIS DONE TODAY OK'
  assert.equal(issue(loud, 'placeholders')?.severity, 'high')
  assert.ok(ids(loud).includes('shouting'))
})

test('structure rules still see the whole prompt, code included', () => {
  const structured = 'Explain the function below.\n\n```js\n// one\n// two\n```'
  const scored = analyzePrompt(structured)
  // The fence is what makes the referenced input delimited.
  assert.ok(!scored.issues.some((i) => i.id === 'missing-input' || i.id === 'undelimited-input'))
  // Stats describe the prompt as written, not the prose the wording rules read.
  assert.equal(scored.stats.lines, 6)
  assert.equal(scored.stats.characters, structured.length)
})

// --- short-prompt ceiling ---------------------------------------------------

test('a broken short prompt scores below a clean one of the same length', () => {
  const broken = analyzePrompt('Translate [insert text] TODO into [language] somehow.')
  const clean = analyzePrompt('Translate "good morning" into French and Spanish.')
  assert.ok(broken.score < clean.score, `${broken.score} vs ${clean.score}`)
  assert.ok(broken.categories.clarity < clean.categories.clarity)
  // Both are still short: neither is allowed to look finished.
  assert.ok(clean.score < 60)

  const usable = analyzePrompt('Translate the attached contract into formal Spanish for our lawyers.')
  const nothing = analyzePrompt('do the thing')
  assert.ok(usable.score > nothing.score, `${usable.score} vs ${nothing.score}`)
})

test('adding one neutral word never moves the score by more than a few points', () => {
  const words = 'Translate the attached contract into formal Spanish for our legal team and keep every defined term exactly as it appears in the source document while preserving the numbering of each clause and annex throughout the whole translated text'.split(
    ' '
  )
  let previous = null
  for (let n = 8; n <= words.length; n++) {
    const score = analyzePrompt(words.slice(0, n).join(' ') + '.').score
    if (previous !== null) {
      assert.ok(Math.abs(score - previous) <= 6, `${n} words: ${previous} -> ${score}`)
    }
    previous = score
  }
})

// --- conflicts --------------------------------------------------------------

test('a resolved choice or a compound noun is not a conflict', () => {
  const resolved = [
    'Write a product description for our new stainless steel water bottle aimed at hikers, under 120 words, in prose, not bullet points.',
    'Write the announcement in prose rather than bullet points, formal tone rather than casual, under 150 words.',
    'Write a short story about a lighthouse keeper who finds a message in a bottle, with detailed sensory descriptions, about 800 words.',
    'Keep it brief but not exhaustive: a summary for the team in three bullets.',
  ]
  for (const t of resolved) {
    const conflicts = ids(t, { intent: 'writing' }).filter((id) => id.startsWith('conflict-'))
    assert.deepEqual(conflicts, [], t)
  }

  // Genuine contradictions are still reported, including the e2e fixture.
  assert.equal(issue('Keep it brief but exhaustive.', 'conflict-brief')?.severity, 'high')
  assert.ok(
    ids(
      'write a blog post about our new feature, make it good and professional. keep it brief but comprehensive, and cite some stats about the latest AI trends!!',
      { intent: 'writing' }
    ).includes('conflict-brief')
  )
  assert.ok(ids('Write a formal cover letter but make it funny, at most 250 words.').includes('conflict-formal'))
})

// --- ungrounded facts -------------------------------------------------------

test('ungrounded-facts ignores engineering nouns, URLs and code prompts', () => {
  const code =
    'Convert every string literal in my TypeScript project to single quotes and add source maps to the webpack config. Return only the changed config, no commentary.'
  assert.ok(!ids(code, { intent: 'code' }).includes('ungrounded-facts'))
  // The same words in a general prompt are still not a request for evidence.
  assert.ok(!ids(code, { intent: 'general' }).includes('ungrounded-facts'))

  const url =
    'Explain the asyncio event loop using https://docs.python.org/3/library/asyncio-eventloop.html#reference as the reference, for an intermediate Python developer, in under 300 words.'
  assert.ok(!ids(url).includes('ungrounded-facts'))

  // Requests for evidence with nothing to draw on are still flagged.
  assert.equal(issue('Write a blog post and cite some stats about the latest AI trends', 'ungrounded-facts')?.severity, 'medium')
  assert.ok(ids('Write a blog post with statistics on remote work productivity for managers.').includes('ungrounded-facts'))
})

// --- role and examples ------------------------------------------------------

test('no-role and no-examples fire only where a role or example plausibly matters', () => {
  const notes =
    'Write release notes for version 2.4 of our mobile app for existing customers. Cover the new offline mode, the redesigned settings screen and the three bug fixes listed in the changelog below. Keep it under 200 words in markdown with one heading per area.\n\n<changelog>\n- offline mode\n- settings redesign\n- fixed crash on login, fixed sync loop, fixed dark mode contrast\n</changelog>'
  const plain = ids(notes, { intent: 'writing' })
  assert.ok(!plain.includes('no-role'), plain.join(', '))
  assert.ok(!plain.includes('no-examples'), plain.join(', '))

  // The fix options opt in, and mirror the rewrite rules that add them.
  assert.equal(issue(notes, 'no-role', { intent: 'writing', addRole: true })?.severity, 'low')
  assert.equal(issue(notes, 'no-examples', { intent: 'writing', includeExample: true })?.severity, 'low')

  // A judgement call depends on who is judging.
  const review =
    'Review this pull request for correctness and maintainability and list every issue you find with a line reference and a suggested fix, ordered by severity, most serious first.'
  const roleIssue = issue(review, 'no-role', { intent: 'code' })
  assert.equal(roleIssue?.severity, 'low')
  // Structured output is where a worked example pays off.
  const extraction =
    'Extract every invoice number, issue date and total from the emails below into a JSON array with keys number, date and total, and emit null for any field that is missing.\n\n<emails>\nfrom: billing@acme.test\n</emails>'
  const exampleIssue = issue(extraction, 'no-examples', { intent: 'extraction' })
  assert.equal(exampleIssue?.severity, 'low')
  // A system prompt wants both.
  const agent =
    'Answer customer questions about our billing plans using only the plan table provided, escalate refund requests to a human agent, and never quote a price that is not in the table.'
  assert.ok(ids(agent, { intent: 'agent' }).includes('no-role'))
  assert.ok(ids(agent, { intent: 'agent' }).includes('no-examples'))

  // The suggestions must not tell the rewrite to add what its rules forbid adding reflexively.
  for (const found of [roleIssue, exampleIssue]) {
    assert.doesNotMatch(found.suggestion, /^Add /, found.suggestion)
  }
})

// --- guard rails for the CLI fixtures --------------------------------------

test('the CLI fixtures keep their shape', () => {
  const vague = analyzePrompt('fix this')
  assert.ok(vague.issues.some((i) => i.severity === 'high'))
  assert.ok(vague.issues.some((i) => i.id === 'too-short'))

  const decent = analyzePrompt(
    'Refactor the parse function in utils.py so it handles empty input and raises ValueError on malformed rows, then add pytest unit tests for the edge cases. Return only the changed function and the new test file.'
  )
  assert.ok(decent.score >= 80 && decent.score < 90, `score ${decent.score}`)
  assert.ok(!decent.issues.some((i) => i.severity === 'high'))
})

test('a rewrite that only drops filler words never scores below the original', () => {
  // Same findings, two fewer words: the ceiling must not turn a tidy-up into a regression.
  const original =
    'Try to find bugs, apply tests, and try to make extra enhancements without breaking existing functionalities. Also, promptfixer always requests an output limit for return.'
  const tidied =
    'Try to find bugs, apply tests, and make extra enhancements without breaking existing functionalities. Also, promptfixer always requests an output limit for return.'
  const before = analyzePrompt(original, { intent: 'code' })
  const after = analyzePrompt(tidied, { intent: 'code', rewrite: true })
  assert.deepEqual(after.issues.map((i) => i.id).sort(), before.issues.map((i) => i.id).sort())
  assert.ok(after.score >= before.score, `tidied ${after.score} must not be below original ${before.score}`)
  // And the ceiling is out of the picture once the length-gated rules apply.
  assert.equal(after.score, before.score)
})
