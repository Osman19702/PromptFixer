/**
 * Front-end logic behind the examples gallery, the fix history, Undo apply,
 * library export/import, the few-shot toggle and the keep/change marks on a
 * rewrite. Like diff.test.js this
 * imports the TypeScript sources directly and needs no DOM; the api client
 * is exercised against a stubbed fetch. Run with: npm test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { api, ApiError } from '../src/lib/api.ts'
import {
  addMark,
  applyExample,
  canRefine,
  EMPTY_HISTORY,
  exportFilename,
  feedbackPayload,
  HISTORY_LIMIT,
  historyCurrent,
  historyDeselect,
  historyNav,
  historyPush,
  historyStep,
  holdsFixShortcut,
  importSummary,
  learnedNote,
  markButton,
  markCapReached,
  markCapTitle,
  markCounts,
  markLabel,
  markRefusedAtCap,
  markSegments,
  marksAfterSelect,
  MAX_MARKS,
  NO_MARKS,
  parseImportFile,
  readExamples,
  refinedNote,
  removeMark,
  resultView,
  shownMarks,
  undoAvailable,
  warningHeadline,
  warningKind,
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

// --- marks on the rewrite ------------------------------------------------------------

//            0         1         2         3         4
//            012345678901234567890123456789012345678901
const TEXT = 'Write a short post. Cite two real sources.'
const keep = (start, end) => ({ start, end, kind: 'keep' })
const change = (start, end) => ({ start, end, kind: 'change' })
const joined = (text, marks) => markSegments(text, marks).map((s) => s.text).join('')

test('marks: a range is clamped to the text and loses the whitespace at both ends', () => {
  assert.deepEqual(addMark([], keep(-5, 7), TEXT), [keep(0, 7)], 'clamped at the start')
  assert.deepEqual(addMark([], change(34, 999), TEXT), [change(34, TEXT.length)], 'clamped at the end')
  // A double-click on Windows drags the trailing space along.
  assert.deepEqual(addMark([], keep(8, 14), TEXT), [keep(8, 13)])
  assert.deepEqual(addMark([], keep(7, 19), TEXT), [keep(8, 19)], 'leading space too')
  assert.deepEqual(addMark([], keep(0, 12), ' \n\tb c\r\n  '), [keep(3, 6)], 'newlines and tabs are whitespace')
  assert.deepEqual(addMark([], keep(13, 8), TEXT), [keep(8, 13)], 'a reversed range is the same range')
})

test('marks: an empty or whitespace-only range returns the same array, so React skips the render', () => {
  const marks = [keep(0, 5)]
  assert.equal(addMark(marks, keep(7, 7), TEXT), marks, 'collapsed')
  assert.equal(addMark(marks, change(7, 8), TEXT), marks, 'only a space')
  assert.equal(addMark(marks, change(1, 4), 'a\n\t b'), marks, 'only newlines and tabs')
  assert.equal(addMark(marks, keep(500, 600), TEXT), marks, 'beyond the text')
  assert.equal(addMark(marks, keep(NaN, 4), TEXT), marks, 'not a range at all')
  assert.notEqual(addMark(marks, keep(8, 13), TEXT), marks)
  assert.deepEqual(marks, [keep(0, 5)], 'never mutated')
})

test('marks: the newest decision replaces every mark it overlaps, in every geometry', () => {
  const existing = [keep(8, 13)] // "short"
  assert.deepEqual(addMark(existing, change(9, 11), TEXT), [change(9, 11)], 'inside the old mark')
  assert.deepEqual(addMark(existing, change(6, 18), TEXT), [change(6, 18)], 'covering it')
  assert.deepEqual(addMark(existing, change(6, 10), TEXT), [change(6, 10)], 'overlapping its left edge')
  assert.deepEqual(addMark(existing, change(11, 18), TEXT), [change(11, 18)], 'overlapping its right edge')
  assert.deepEqual(addMark(existing, keep(8, 13), TEXT), [keep(8, 13)], 'the same range again is still one mark')
  assert.deepEqual(addMark(existing, change(8, 13), TEXT), [change(8, 13)], 'same range, other verdict')

  // One selection dragged across several marks takes them all out, and spares the rest.
  const three = [keep(0, 5), change(8, 13), keep(20, 24)]
  assert.deepEqual(addMark(three, change(3, 22), TEXT), [change(3, 22)])
  assert.deepEqual(addMark(three, change(6, 15), TEXT), [keep(0, 5), change(6, 15), keep(20, 24)])
})

test('marks: touching is not overlapping, and the list stays sorted by start', () => {
  assert.deepEqual(addMark([keep(8, 11)], change(11, 13), TEXT), [keep(8, 11), change(11, 13)], 'starts where the other ends')
  assert.deepEqual(addMark([keep(10, 13)], change(8, 10), TEXT), [change(8, 10), keep(10, 13)], 'ends where the other starts')
  // Only the trimmed range counts: the dragged-along space does not reach the next mark.
  assert.deepEqual(addMark([keep(14, 18)], change(8, 15), TEXT), [change(8, 15)])
  assert.deepEqual(addMark([keep(14, 18)], change(8, 14), TEXT), [change(8, 13), keep(14, 18)])
  assert.deepEqual(addMark([keep(20, 24), keep(0, 5)], change(8, 13), TEXT), [keep(0, 5), change(8, 13), keep(20, 24)])
})

test('marks: removeMark drops one mark and ignores an index that is not there', () => {
  const marks = [keep(0, 5), change(8, 13), keep(20, 24)]
  assert.deepEqual(removeMark(marks, 1), [keep(0, 5), keep(20, 24)])
  assert.deepEqual(removeMark(marks, 0), [change(8, 13), keep(20, 24)])
  assert.equal(removeMark(marks, 3), marks)
  assert.equal(removeMark(marks, -1), marks, '-1 is the index of a plain segment')
  assert.equal(marks.length, 3, 'never mutated')
})

test('marks: segments always join back to exactly the text', () => {
  assert.deepEqual(markSegments(TEXT, []), [{ text: TEXT, kind: null, index: -1 }])
  assert.deepEqual(markSegments('', []), [])

  const marks = [keep(8, 13), change(20, 24)]
  assert.deepEqual(markSegments(TEXT, marks), [
    { text: 'Write a ', kind: null, index: -1 },
    { text: 'short', kind: 'keep', index: 0 },
    { text: ' post. ', kind: null, index: -1 },
    { text: 'Cite', kind: 'change', index: 1 },
    { text: ' two real sources.', kind: null, index: -1 },
  ])

  // Marks at the very start and the very end leave no empty plain segment behind.
  const ends = [keep(0, 5), change(34, TEXT.length)]
  assert.deepEqual(markSegments(TEXT, ends), [
    { text: 'Write', kind: 'keep', index: 0 },
    { text: ' a short post. Cite two real ', kind: null, index: -1 },
    { text: 'sources.', kind: 'change', index: 1 },
  ])
  const whole = [keep(0, TEXT.length)]
  assert.deepEqual(markSegments(TEXT, whole), [{ text: TEXT, kind: 'keep', index: 0 }])
  const touching = [keep(8, 11), change(11, 13)]
  assert.deepEqual(markSegments(TEXT, touching).map((s) => s.text), ['Write a ', 'sho', 'rt', ' post. Cite two real sources.'])

  for (const set of [[], marks, ends, whole, touching]) assert.equal(joined(TEXT, set), TEXT)
  const multiline = 'line one\r\nline two\n\n  indented'
  assert.equal(joined(multiline, [keep(5, 8), change(10, 14)]), multiline)
})

test('marks: a mark that does not fit the text is left out rather than bending pre.output', () => {
  // Made for a longer rewrite, overlapping an earlier mark, empty, out of order: the invariant still holds.
  const stale = [keep(30, 400), change(8, 13), keep(10, 16), change(5, 5)]
  const segments = markSegments(TEXT, stale)
  assert.equal(segments.map((s) => s.text).join(''), TEXT)
  assert.deepEqual(
    segments.filter((s) => s.kind),
    [{ text: 'short', kind: 'change', index: 1 }],
    'index still points into the list as it was given'
  )
  assert.equal(joined('tiny', stale), 'tiny')
})

test('marks: the count and the screen-reader label of a highlight', () => {
  assert.deepEqual(markCounts([]), { keep: 0, change: 0 })
  assert.deepEqual(markCounts([keep(0, 5), change(8, 13), keep(20, 24)]), { keep: 2, change: 1 })

  assert.equal(markLabel('keep', 'short'), 'Marked to keep: “short”. Activate to remove this mark.')
  assert.equal(
    markLabel('change', 'Cite two\n  real sources.'),
    'Marked to change: “Cite two real sources.”. Activate to remove this mark.'
  )
  // An aria-label replaces the highlight's content for a screen reader, so a clipped label would
  // put the rest of the passage out of reach. (This used to pin a 60-character clip.)
  const passage = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' \n')
  const long = markLabel('keep', passage)
  assert.equal(long, `Marked to keep: “${passage.replace(/\s+/g, ' ')}”. Activate to remove this mark.`)
  assert.ok(long.includes('word59') && !long.includes('…'), 'the whole passage, to its last word')
})

test('marks: a kind stops at the number of passages the server reads', async () => {
  // The cap is the server's own. It is not exported there, and importing index.js would start a server.
  const { readFile } = await import('node:fs/promises')
  const server = await readFile(new URL('./index.js', import.meta.url), 'utf8')
  assert.equal(Number(server.match(/^const MAX_MARKS = (\d+)\s*$/m)?.[1]), MAX_MARKS, 'src/lib/ui.ts and server/index.js agree')

  const text = 'ab '.repeat(MAX_MARKS + 5)
  const at = (i, kind) => ({ start: i * 3, end: i * 3 + 2, kind })
  let marks = []
  for (let i = 0; i < MAX_MARKS; i++) marks = addMark(marks, at(i, 'keep'), text)
  assert.deepEqual(markCounts(marks), { keep: MAX_MARKS, change: 0 })
  assert.equal(markCapReached(marks, 'keep'), true)
  assert.equal(markCapReached(marks, 'change'), false, 'each kind has its own cap')
  assert.equal(markCapReached(marks.slice(1), 'keep'), false)

  assert.equal(addMark(marks, at(MAX_MARKS, 'keep'), text), marks, 'one too many is refused: the same array')
  assert.equal(markCounts(addMark(marks, at(MAX_MARKS, 'change'), text)).change, 1, 'the other kind is still open')
  // Redrawing or flipping one of the twenty does not add a passage, so it is not refused.
  assert.deepEqual(markCounts(addMark(marks, { start: 0, end: 5, kind: 'keep' }, text)), { keep: MAX_MARKS - 1, change: 0 })
  assert.deepEqual(markCounts(addMark(marks, at(3, 'change'), text)), { keep: MAX_MARKS - 1, change: 1 })
  const freed = removeMark(marks, 0)
  assert.equal(markCounts(addMark(freed, at(MAX_MARKS, 'keep'), text)).keep, MAX_MARKS, 'removing one makes room')

  assert.match(markCapTitle('keep'), new RegExp(`^${MAX_MARKS} passages kept is the most`))
  assert.match(markCapTitle('change'), new RegExp(`^${MAX_MARKS} passages to change is the most`))
})

test('marks: at the cap a button refuses exactly the presses the reducer would drop', () => {
  // 'ab cd ab cd …': the i-th 'ab' stands at i * 6. The first twenty are kept, and number 22 is to change.
  const text = 'ab cd '.repeat(MAX_MARKS + 5)
  const at = (i, kind) => ({ start: i * 6, end: i * 6 + 2, kind })
  let marks = []
  for (let i = 0; i < MAX_MARKS; i++) marks = addMark(marks, at(i, 'keep'), text)
  marks = addMark(marks, at(22, 'change'), text)
  const open = { disabled: false, title: undefined }
  const capped = (kind) => ({ disabled: true, title: markCapTitle(kind) })
  const button = (kind, range, list = marks) => markButton(list, range, kind, text)

  // Nothing selected: both are dead, and the full kind says why.
  assert.deepEqual(button('keep', null), capped('keep'))
  assert.deepEqual(button('change', null), { disabled: true, title: undefined })

  // A twenty-first passage is refused; the other verdict has room.
  assert.deepEqual(button('keep', at(MAX_MARKS, 'keep')), capped('keep'))
  assert.deepEqual(button('change', at(MAX_MARKS, 'keep')), open)
  // This used to be refused too: a selection that redraws, shrinks or merges kept passages adds none.
  const redraws = { exact: at(4), wider: { start: 24, end: 29 }, 'with its spaces': { start: 23, end: 27 }, shrunk: { start: 24, end: 25 }, merged: { start: 24, end: 32 } }
  for (const [name, range] of Object.entries(redraws)) {
    assert.deepEqual(button('keep', range), open, name)
    const next = addMark(marks, { ...range, kind: 'keep' }, text)
    assert.ok(next !== marks && markCounts(next).keep <= MAX_MARKS, `${name}: the press is taken, and the kind stays within the cap`)
  }
  // A backwards range is the same range.
  assert.deepEqual(button('keep', { start: 29, end: 24 }), open)

  // Flipping a verdict: a kept passage can always become one to change, but the
  // passage to change cannot become a twenty-first kept one…
  assert.deepEqual(button('change', at(4)), open)
  assert.deepEqual(button('keep', at(22)), capped('keep'))
  assert.equal(addMark(marks, at(22, 'keep'), text), marks)
  // …unless the same selection takes a kept one with it, or the kind has room.
  assert.deepEqual(button('keep', { start: 114, end: 134 }), open, 'from kept number 19 through number 22')
  assert.deepEqual(markCounts(addMark(marks, { start: 114, end: 134, kind: 'keep' }, text)), { keep: MAX_MARKS, change: 0 })
  const roomy = removeMark(marks, 0)
  assert.deepEqual(button('keep', at(22), roomy), open)
  assert.deepEqual(markCounts(addMark(roomy, at(22, 'keep'), text)), { keep: MAX_MARKS, change: 0 })

  // Whitespace is nothing to mark at any count. The cap is not why, so the button does not blame it:
  // it stays as it is below the cap, and the press does nothing.
  for (const blank of [{ start: 2, end: 3 }, { start: 125, end: 126 }, { start: text.length, end: text.length + 9 }]) {
    assert.deepEqual(button('keep', blank), open)
    assert.deepEqual(button('keep', blank, roomy), open, 'as below the cap')
    assert.equal(markRefusedAtCap(marks, { ...blank, kind: 'keep' }, text), false)
    assert.equal(addMark(marks, { ...blank, kind: 'keep' }, text), marks)
  }

  // Below the cap nothing is ever refused for it.
  for (const range of [at(MAX_MARKS), at(4), at(22), { start: 0, end: text.length }]) {
    for (const kind of ['keep', 'change']) assert.deepEqual(button(kind, range, roomy), open)
  }

  // The rule is the reducer's own, whatever is selected: refused means a press that changes
  // nothing although there is something to mark, and only a full kind refuses.
  let seed = 7
  const random = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n)
  for (let round = 0; round < 2000; round++) {
    const list = round % 3 ? marks : roomy
    const a = random(text.length + 3) - 1
    const range = { start: a, end: a + random(12) - 1 }
    const markable = text.slice(Math.max(0, Math.min(range.start, range.end)), Math.max(0, range.start, range.end)).trim() !== ''
    for (const kind of ['keep', 'change']) {
      const dropped = addMark(list, { ...range, kind }, text) === list
      assert.equal(markRefusedAtCap(list, { ...range, kind }, text), dropped && markable, JSON.stringify({ range, kind }))
      assert.equal(button(kind, range, list).disabled, dropped && markable)
      if (dropped && markable) assert.equal(markCapReached(list, kind), true)
    }
  }
})

test('marks: they survive the result being parked by a keystroke, and die with the selection', () => {
  const result = { ...fixNamed(1), before: { score: 30, issues: [] }, after: { score: 80, issues: [] } }
  const live = { score: 55, issues: [] }
  const marked = { result, marks: [keep(0, 2)] }

  // One keystroke in the editor: the rewrite hides, but it is still the history's selection.
  const parked = resultView(result, live, 'o1 ', false)
  assert.equal(parked.active, null)
  assert.equal(marksAfterSelect(marked, result), marked, 'kept, and the same object: no render')
  assert.equal(shownMarks(marked, parked.active), NO_MARKS, 'nothing to paint or to fix again with while it is hidden')
  // Backspace, or "Show last fix": the same rewrite is back, and so are its marks.
  assert.equal(shownMarks(marked, resultView(result, live, 'o1', false).active), marked.marks)
  assert.equal(shownMarks(marked, resultView(result, live, 'o1 ', true).active), marked.marks)

  // A new fix, a refine or a history step selects another result; Apply, Clear, an example and a library load select none.
  const other = fixNamed(2)
  assert.equal(marksAfterSelect(marked, other), null)
  assert.equal(marksAfterSelect(marked, null), null)
  assert.equal(marksAfterSelect(marked, { ...result }), null, 'a result is the object, not a look-alike')
  assert.equal(marksAfterSelect(null, result), null)
  // And until the effect has run, they are never painted onto a different rewrite.
  assert.equal(shownMarks(marked, other), NO_MARKS)
  assert.equal(shownMarks(null, result), NO_MARKS)
  assert.equal(shownMarks(null, null), NO_MARKS, 'one shared empty list')
})

test('marks: Ctrl+Enter is held only while there are marks to lose', () => {
  const ctrlEnter = { key: 'Enter', ctrlKey: true, metaKey: false }
  const marks = [keep(0, 5)]
  assert.equal(holdsFixShortcut(ctrlEnter, marks), true, 'a fresh fix would throw the marks away')
  assert.equal(holdsFixShortcut({ key: 'Enter', ctrlKey: false, metaKey: true }, marks), true, 'Cmd+Enter too')
  assert.equal(holdsFixShortcut(ctrlEnter, []), false, 'nothing to lose: the app-wide shortcut runs a fix, as it did before marks')
  assert.equal(holdsFixShortcut({ key: 'Enter', ctrlKey: false, metaKey: false }, marks), false, 'a plain Enter removes a mark')
  assert.equal(holdsFixShortcut({ key: 'a', ctrlKey: true, metaKey: false }, marks), false)
})

test('marks: the feedback payload carries the marked passages, de-duplicated and split by kind', () => {
  assert.equal(feedbackPayload(TEXT, []), null, 'no marks, no feedback: an ordinary fix')

  const text = 'Be brief. Be brief. Cite sources.'
  assert.deepEqual(feedbackPayload(text, [keep(0, 9), keep(10, 19), change(20, 33)]), {
    previous: text,
    keep: ['Be brief.'],
    change: ['Cite sources.'],
  })
  // The same words under both verdicts go out under both; the server lets the change win.
  assert.deepEqual(feedbackPayload(text, [keep(0, 9), change(10, 19)]), {
    previous: text,
    keep: ['Be brief.'],
    change: ['Be brief.'],
  })
  assert.deepEqual(feedbackPayload(text, [change(20, 33)]), { previous: text, keep: [], change: ['Cite sources.'] })
  // Passages go out exactly as marked, inner whitespace and all; the server does the collapsing.
  assert.deepEqual(feedbackPayload('Be  brief.\nAlways.', [keep(0, 18)]).keep, ['Be  brief.\nAlways.'])
  assert.equal(feedbackPayload('short', [keep(40, 50)]), null, 'marks that point at nothing are not feedback')
})

test("marks: canRefine is the Fix gate on the result's original, plus at least one mark", () => {
  const ready = { downloaded: true, phase: 'ready', catalog: [] }
  const gate = { prompt: 'the original prompt', model: 'm', provider: 'openai', fixing: false, cancelling: false, localStatus: null }
  const marks = [keep(0, 5)]
  assert.equal(canRefine(gate, marks), true)
  assert.equal(canRefine(gate, []), false, 'nothing marked')
  assert.equal(canRefine({ ...gate, fixing: true }, marks), false, 'a fix is in flight')
  assert.equal(canRefine({ ...gate, cancelling: true }, marks), false, 'the cancel settle window')
  assert.equal(canRefine({ ...gate, model: '' }, marks), false, 'no model')
  assert.equal(canRefine({ ...gate, prompt: '  ' }, marks), false, 'no result to refine')
  assert.equal(canRefine({ ...gate, provider: 'local' }, marks), false, 'local status unknown')
  assert.equal(canRefine({ ...gate, provider: 'local', localStatus: { ...ready, downloaded: false } }, marks), false, 'local model missing')
  assert.equal(canRefine({ ...gate, provider: 'local', localStatus: { ...ready, phase: 'downloading' } }, marks), false)
  assert.equal(canRefine({ ...gate, provider: 'local', localStatus: ready }, marks), true)
})

test('marks: the What changed line reports a refine with the marks that were honoured', () => {
  assert.equal(refinedNote({}), '', 'an ordinary fix, or a server that predates marks')
  const feedback = { keep: 2, change: 1, missingKeep: [], unchangedChange: [] }
  assert.equal(refinedNote({ feedback }), ' · refined with your marks (2 kept, 1 changed)')
  assert.equal(refinedNote({ feedback: { ...feedback, change: 0 } }), ' · refined with your marks (2 kept, 0 changed)')
  // Never claims more than the warning banner admits.
  const missed = { keep: 2, change: 1, missingKeep: ['Be brief.'], unchangedChange: ['Cite sources.'] }
  assert.equal(refinedNote({ feedback: missed }), ' · refined with your marks (1 kept, 0 changed)')
  assert.equal(refinedNote({ feedback: { keep: 1, change: 1 } }), ' · refined with your marks (1 kept, 1 changed)', 'tolerates missing lists')
})

test('marks: a feedback warning gets its own headline', () => {
  const meta = { warning: 'The rewrite did not follow all of your marks.', warningKind: 'feedback' }
  assert.equal(warningKind(meta), 'feedback')
  assert.equal(warningHeadline(meta), 'Did not follow all of your marks')
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

test('api: fix sends feedback through untouched, and an ordinary fix carries none', async () => {
  const feedback = { previous: 'Be brief.  Cite sources.', keep: ['Be brief.'], change: ['Cite sources.'] }
  const meta = { feedback: { keep: 1, change: 1, missingKeep: [], unchangedChange: [] } }
  await withFetch({ body: { meta } }, async (calls) => {
    const res = await api.fix({ prompt: 'the original', provider: 'openai', model: 'm', options: OPTIONS, feedback })
    assert.deepEqual(res.meta.feedback, meta.feedback)
    assert.equal(calls[0].url, '/api/fix')
    assert.equal(calls[0].method, 'POST')
    const sent = JSON.parse(calls[0].body)
    assert.deepEqual(sent.feedback, feedback, 'passages and whitespace exactly as marked')
    assert.equal(sent.prompt, 'the original', 'prompt stays the original, not the rewrite')
    assert.deepEqual(sent.options, OPTIONS)
  })
  await withFetch({ body: { meta: {} } }, async (calls) => {
    await api.fix({ prompt: 'p', provider: 'openai', model: 'm', options: OPTIONS })
    assert.equal('feedback' in JSON.parse(calls[0].body), false)
  })
})
