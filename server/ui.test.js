/**
 * Front-end logic behind the examples gallery, the fix history, Undo apply,
 * library export/import and the few-shot toggle. Like diff.test.js this
 * imports the TypeScript sources directly and needs no DOM; the api client
 * is exercised against a stubbed fetch. Run with: npm test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { api, ApiError } from '../src/lib/api.ts'
import {
  applyExample,
  EMPTY_HISTORY,
  exportFilename,
  HISTORY_LIMIT,
  historyCurrent,
  historyDeselect,
  historyNav,
  historyPush,
  historyStep,
  importSummary,
  learnedNote,
  parseImportFile,
  readExamples,
  resultView,
  undoAvailable,
} from '../src/lib/ui.ts'

// --- fix history ---------------------------------------------------------------

const fixNamed = (n) => ({ original: `o${n}`, fixedPrompt: `f${n}`, before: { score: 1 }, after: { score: 2 } })

test('history: a fresh fix appends and becomes the selection', () => {
  let h = historyPush(EMPTY_HISTORY, fixNamed(1))
  assert.equal(historyCurrent(h), h.items[0])
  assert.deepEqual(historyNav(h), { label: '1 of 1', canPrev: false, canNext: false })

  h = historyPush(h, fixNamed(2))
  assert.equal(historyCurrent(h).original, 'o2', 'newest is selected')
  assert.deepEqual(historyNav(h), { label: '2 of 2', canPrev: true, canNext: false })
})

test('history: keeps only the last 10 results', () => {
  let h = EMPTY_HISTORY
  for (let i = 1; i <= HISTORY_LIMIT + 3; i++) h = historyPush(h, fixNamed(i))
  assert.equal(h.items.length, HISTORY_LIMIT)
  assert.equal(h.items[0].original, 'o4', 'oldest three fell off')
  assert.equal(historyCurrent(h).original, `o${HISTORY_LIMIT + 3}`)
  assert.equal(historyNav(h).label, `${HISTORY_LIMIT} of ${HISTORY_LIMIT}`)
})

test('history: prev/next move the selection and clamp at both ends', () => {
  let h = EMPTY_HISTORY
  for (let i = 1; i <= 5; i++) h = historyPush(h, fixNamed(i))
  h = historyStep(h, -1)
  h = historyStep(h, -1)
  assert.equal(historyNav(h).label, '3 of 5')
  assert.equal(historyCurrent(h).original, 'o3', 'the tabs follow the selected result')
  assert.equal(historyStep(h, -10).index, 0, 'clamps at the oldest')
  assert.equal(historyStep(h, 10).index, 4, 'clamps at the newest')
  assert.deepEqual(historyNav(historyStep(h, -10)), { label: '1 of 5', canPrev: false, canNext: true })
  assert.equal(historyStep(EMPTY_HISTORY, -1), EMPTY_HISTORY, 'nothing to step through')
  const newest = historyStep(h, 10)
  assert.equal(historyStep(newest, 1), newest, 'a no-op step returns the same object, so React skips the render')
})

test('history: Apply parks the selection but keeps the entries reachable', () => {
  let h = historyPush(historyPush(EMPTY_HISTORY, fixNamed(1)), fixNamed(2))
  h = historyDeselect(h)
  assert.equal(historyCurrent(h), null)
  assert.equal(h.items.length, 2, 'entries survive')
  assert.deepEqual(historyNav(h), { label: '2 earlier', canPrev: true, canNext: false })
  assert.equal(historyDeselect(h), h, 'idempotent')
  // "previous" from the parked state reopens the most recent fix.
  assert.equal(historyCurrent(historyStep(h, -1)).original, 'o2')
  assert.equal(historyStep(h, 1), h, '"next" has nowhere to go')
  assert.deepEqual(historyNav(EMPTY_HISTORY), { label: '', canPrev: false, canNext: false })
})

test('history: a pinned older result owns the Issues tab even though the editor moved on', () => {
  const older = { ...fixNamed(1), before: { score: 30, issues: [] }, after: { score: 80, issues: [] } }
  const live = { score: 55, issues: [] }
  const parked = resultView(older, live, 'something else', false)
  assert.equal(parked.active, null)
  assert.equal(parked.shown, live)

  const pinned = resultView(older, live, 'something else', false, true)
  assert.equal(pinned.edited, true, 'the banner still says the editor differs')
  assert.equal(pinned.active, older)
  assert.equal(pinned.shown, older.after, 'Issues scores the selected result')
  assert.equal(pinned.compareTo, older.before)
  assert.equal(resultView(null, live, 'x', false, true).active, null)
})

// --- examples gallery ------------------------------------------------------------

const OPTIONS = {
  intent: 'general',
  targetModel: 'claude',
  strength: 'balanced',
  preserveTone: true,
  includeExample: false,
  addRole: false,
  notes: 'keep it short',
  fewShot: true,
}

test('examples: choosing one sets the prompt, intent and strength and keeps every other option', () => {
  const ex = { prompt: 'fix my login function', intent: 'code', strength: 'aggressive' }
  const next = applyExample(ex, OPTIONS)
  assert.equal(next.prompt, ex.prompt)
  assert.deepEqual(next.options, { ...OPTIONS, intent: 'code', strength: 'aggressive' })
  assert.notEqual(next.options, OPTIONS, 'does not mutate the current options')
  // A partially filled example falls back to what the user had.
  assert.deepEqual(applyExample({ prompt: 'p', intent: '', strength: '' }, OPTIONS).options, OPTIONS)
})

test('examples: a missing or malformed /api/examples is an empty gallery, not a crash', () => {
  assert.deepEqual(readExamples(undefined), [])
  assert.deepEqual(readExamples({ error: 'Not found' }), [])
  assert.deepEqual(readExamples({ examples: 'nope' }), [])
  const good = { id: 'vague-code', name: 'Vague code request', useCase: 'u', prompt: 'p', intent: 'code', strength: 'balanced', expected: 'e' }
  assert.deepEqual(readExamples({ examples: [good, null, { id: 'x' }, 'str'] }), [good])
})

// --- undo apply --------------------------------------------------------------------

test('undo: available once after Apply, and only while the editor still holds the applied text', () => {
  const undo = { before: 'my draft', applied: 'my improved draft' }
  assert.equal(undoAvailable(null, 'my improved draft'), false, 'nothing applied yet')
  assert.equal(undoAvailable(undo, 'my improved draft'), true)
  assert.equal(undoAvailable(undo, 'my improved draft, edited'), false, 'edits are never thrown away')
  assert.equal(undoAvailable(undo, 'my draft'), false, 'after Undo the editor holds `before`, so no second shot')
})

// --- library export / import ---------------------------------------------------------

test('export: the download name mirrors the server Content-Disposition date', () => {
  assert.equal(exportFilename('2026-09-05T14:03:00.000Z'), 'promptfixer-library-2026-09-05.json')
  assert.match(exportFilename('garbage'), /^promptfixer-library-\d{4}-\d{2}-\d{2}\.json$/)
})

test('import: accepts our export shape or a bare list and rejects the rest with a readable message', () => {
  const entry = { id: 'a', title: 't', original: 'o', fixed: 'f' }
  assert.deepEqual(parseImportFile(JSON.stringify({ version: 1, exportedAt: 'x', entries: [entry] })), [entry])
  assert.deepEqual(parseImportFile(JSON.stringify([entry])), [entry])
  assert.throws(() => parseImportFile('{not json'), /not valid JSON/)
  assert.throws(() => parseImportFile(JSON.stringify({ entries: 'nope' })), /"entries" list/)
  assert.throws(() => parseImportFile('42'), /"entries" list/)
})

test('import: the toast reports the counts', () => {
  assert.equal(importSummary({ imported: 3, skipped: 0, total: 3 }), 'Imported 3 prompts')
  assert.equal(importSummary({ imported: 1, skipped: 2, total: 3 }), 'Imported 1 prompt · 2 skipped (already saved or malformed)')
  assert.equal(importSummary({ imported: 0, skipped: 4, total: 4 }), 'Nothing new to import · all 4 already saved or malformed')
  assert.equal(importSummary({ imported: 0, skipped: 0, total: 0 }), 'That file has no prompts to import')
})

// --- few-shot ----------------------------------------------------------------------

test('few-shot: the What changed line only mentions examples when the server used some', () => {
  assert.equal(learnedNote({ examplesUsed: 0 }), '')
  assert.equal(learnedNote({}), '', 'older servers omit the field')
  assert.equal(learnedNote({ examplesUsed: 1 }), ' · learned from 1 saved example')
  assert.equal(learnedNote({ examplesUsed: 2 }), ' · learned from 2 saved examples')
})

// --- api client ----------------------------------------------------------------------

/** Replace fetch for one test; records every call and answers from `reply`. */
async function withFetch(reply, run) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body })
    const { status = 200, body = {} } = typeof reply === 'function' ? reply(url) : reply
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }
  try {
    await run(calls)
  } finally {
    globalThis.fetch = original
  }
}

test('api: examples.list reads GET /api/examples and a 404 surfaces as an ApiError', async () => {
  const examples = [{ id: 'x', name: 'X', useCase: 'u', prompt: 'p', intent: 'code', strength: 'light', expected: 'e' }]
  await withFetch({ body: { examples } }, async (calls) => {
    const res = await api.examples.list()
    assert.deepEqual(res.examples, examples)
    assert.deepEqual(calls, [{ url: '/api/examples', method: 'GET', body: undefined }])
  })
  await withFetch({ status: 404, body: { error: 'Not found' } }, async () => {
    await assert.rejects(api.examples.list(), (err) => err instanceof ApiError && err.status === 404)
  })
})

test('api: library.export returns the parsed export and library.import posts { entries }', async () => {
  const entries = [{ id: 'a', title: 't', original: 'o', fixed: 'f' }]
  const exported = { version: 1, exportedAt: '2026-09-05T00:00:00.000Z', entries }
  await withFetch({ body: exported }, async (calls) => {
    assert.deepEqual(await api.library.export(), exported)
    assert.deepEqual(calls, [{ url: '/api/library/export', method: 'GET', body: undefined }])
  })
  await withFetch({ body: { imported: 1, skipped: 0, total: 1 } }, async (calls) => {
    assert.deepEqual(await api.library.import(entries), { imported: 1, skipped: 0, total: 1 })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, '/api/library/import')
    assert.equal(calls[0].method, 'POST')
    assert.deepEqual(JSON.parse(calls[0].body), { entries })
  })
})

test('api: fix sends options.fewShot through untouched', async () => {
  await withFetch({ body: { meta: { examplesUsed: 2 } } }, async (calls) => {
    const res = await api.fix({ prompt: 'p', provider: 'openai', model: 'm', options: { ...OPTIONS, fewShot: false } })
    assert.equal(res.meta.examplesUsed, 2)
    assert.equal(JSON.parse(calls[0].body).options.fewShot, false)
  })
})
