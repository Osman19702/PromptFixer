/**
 * Decision logic lifted out of the components so it can be unit-tested from
 * node:test without a DOM (see server/diff.test.js). Keep this file free of
 * React and of TypeScript syntax that Node cannot strip (enums, namespaces,
 * parameter properties).
 */
import type {
  Analysis,
  ExamplePrompt,
  FixFeedback,
  FixOptions,
  FixResult,
  ImportResult,
  LibraryEntry,
  LocalStatus,
  WarningKind,
} from '../types'

const HEADLINES: Record<WarningKind, string> = {
  leak: 'The model copied its instructions into the rewrite',
  retention: 'Rewrote more than the strength allows',
  growth: 'Added more than the strength allows',
  feedback: 'Did not follow all of your marks',
}

/** The server tags the kind; older responses only carry the sentence, so infer it. */
export function warningKind(meta: { warning?: string; warningKind?: WarningKind }): WarningKind {
  if (meta.warningKind && meta.warningKind in HEADLINES) return meta.warningKind
  const text = meta.warning ?? ''
  if (/copied its instructions|boilerplate/i.test(text)) return 'leak'
  if (/\b(added|grew|longer|expanded)\b/i.test(text)) return 'growth'
  return 'retention'
}

export function warningHeadline(meta: { warning?: string; warningKind?: WarningKind }): string {
  return HEADLINES[warningKind(meta)]
}

/** A local fix needs the weights on disk and no download in the way. */
export function localBlocked(status: LocalStatus | null): boolean {
  return !status || !status.downloaded || status.phase === 'downloading'
}

/**
 * Whether the server has nothing in flight. `busy` is additive on the status
 * shape; a server that does not report it is treated as idle so an older
 * server never wedges the Fix button.
 */
export function localIdle(status: LocalStatus): boolean {
  return status.busy !== true
}

export interface FixGate {
  prompt: string
  model: string
  provider: string
  fixing: boolean
  /** True between Cancel and the server confirming it dropped the generation. */
  cancelling: boolean
  localStatus: LocalStatus | null
}

/** One source of truth for the Fix button and the Ctrl+Enter shortcut. */
export function canFix(g: FixGate): boolean {
  if (!g.prompt.trim() || !g.model || g.fixing || g.cancelling) return false
  if (g.provider === 'local' && localBlocked(g.localStatus)) return false
  return true
}

export type TierAction =
  | { kind: 'none' }
  | { kind: 'adopt'; tier: string }
  | { kind: 'push'; tier: string }

/**
 * Reconcile the UI's remembered tier with the server's. An unknown tier adopts
 * the server's; a known one that differs is pushed with /api/local/select so
 * status, banners and the fix all describe the same model. Downloads and loads
 * are left alone until they finish.
 */
export function localTierAction(model: string, status: LocalStatus): TierAction {
  const valid = !!model && status.catalog.some((c) => c.id === model)
  if (!valid) return { kind: 'adopt', tier: status.tier }
  if (model === status.tier) return { kind: 'none' }
  if (status.phase === 'downloading' || status.phase === 'loading') return { kind: 'none' }
  return { kind: 'push', tier: model }
}

export interface ResultView {
  /** The editor no longer holds the text the fix was made for. */
  edited: boolean
  /** The result whose Fixed/Diff/Changes tabs may be rendered, if any. */
  active: FixResult | null
  /** What the Issues tab scores: the rewrite while it is current, else the editor. */
  shown: Analysis | null
  compareTo: Analysis | null
}

/**
 * Once the prompt diverges from the fix's original, the live analysis leads.
 * `pinned` is set when the user stepped through the fix history on purpose:
 * that result then owns every tab, including Issues, until the editor changes.
 */
export function resultView(
  result: FixResult | null,
  analysis: Analysis | null,
  prompt: string,
  showLastFix: boolean,
  pinned = false
): ResultView {
  const edited = !!result && prompt !== result.original
  const current = result && (!edited || pinned) ? result : null
  return {
    edited,
    active: current ?? (showLastFix ? result : null),
    shown: current ? current.after : analysis,
    compareTo: current ? current.before : null,
  }
}

/**
 * Keyboard activation of a composite "button" that contains real buttons: only
 * Enter/Space on the wrapper itself count, so a nested Delete keeps its own key.
 */
export function activatesEntry(e: { key: string; target: unknown; currentTarget: unknown }): boolean {
  return (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget
}

// --- fix history -------------------------------------------------------------

export const HISTORY_LIMIT = 10

export interface FixHistory {
  /** Oldest first; never longer than HISTORY_LIMIT. */
  items: FixResult[]
  /** Index of the result the tabs show, or -1 after Apply/Clear parked it. */
  index: number
}

export const EMPTY_HISTORY: FixHistory = { items: [], index: -1 }

/** A fresh fix goes on the end and becomes the selection; the oldest falls off. */
export function historyPush(h: FixHistory, result: FixResult): FixHistory {
  const items = [...h.items, result].slice(-HISTORY_LIMIT)
  return { items, index: items.length - 1 }
}

/**
 * Move the selection by `delta`, clamped to the list. From the parked state
 * (-1) "previous" reopens the most recent result and "next" does nothing.
 */
export function historyStep(h: FixHistory, delta: number): FixHistory {
  const last = h.items.length - 1
  if (last < 0 || (h.index < 0 && delta >= 0)) return h
  const from = h.index < 0 ? last + 1 : h.index
  const index = Math.min(last, Math.max(0, from + delta))
  return index === h.index ? h : { ...h, index }
}

/** Keep the entries but show none, e.g. after Apply moved the text into the editor. */
export function historyDeselect(h: FixHistory): FixHistory {
  return h.index < 0 ? h : { ...h, index: -1 }
}

export function historyCurrent(h: FixHistory): FixResult | null {
  return h.items[h.index] ?? null
}

export interface HistoryNav {
  /** "3 of 5" while a result is selected; "5 earlier" while parked; '' when empty. */
  label: string
  canPrev: boolean
  canNext: boolean
}

export function historyNav(h: FixHistory): HistoryNav {
  const n = h.items.length
  const selected = h.index >= 0
  return {
    label: selected ? `${h.index + 1} of ${n}` : n ? `${n} earlier` : '',
    canPrev: selected ? h.index > 0 : n > 0,
    canNext: selected && h.index < n - 1,
  }
}

// --- examples gallery ----------------------------------------------------------

/** Editor state for a chosen example: its text plus its intent and strength; every other option is kept. */
export function applyExample(
  example: Pick<ExamplePrompt, 'prompt' | 'intent' | 'strength'>,
  options: FixOptions
): { prompt: string; options: FixOptions } {
  return {
    prompt: example.prompt,
    options: {
      ...options,
      intent: example.intent || options.intent,
      strength: example.strength || options.strength,
    },
  }
}

/** /api/examples may be missing on an older server; anything but a list of named examples is an empty gallery. */
export function readExamples(body: unknown): ExamplePrompt[] {
  const list = (body as { examples?: unknown })?.examples
  if (!Array.isArray(list)) return []
  return list.filter(
    (e): e is ExamplePrompt =>
      !!e && typeof e === 'object' && typeof e.id === 'string' && typeof e.name === 'string' && typeof e.prompt === 'string'
  )
}

// --- undo apply ------------------------------------------------------------------

export interface UndoApply {
  /** What the editor held before Apply. */
  before: string
  /** What Apply wrote, so an edited editor is never overwritten by Undo. */
  applied: string
}

/** Undo is one-shot and only while the editor still shows exactly what Apply put there. */
export function undoAvailable(undo: UndoApply | null, prompt: string): boolean {
  return !!undo && prompt === undo.applied
}

// --- library export / import ---------------------------------------------------------

/** Mirrors the server's Content-Disposition name, since a Blob download cannot read the header. */
export function exportFilename(exportedAt: string): string {
  const d = new Date(exportedAt)
  const day = Number.isNaN(d.getTime()) ? new Date() : d
  return `promptfixer-library-${day.toISOString().slice(0, 10)}.json`
}

/** Accept our own export ({ entries }) or a bare array; anything else is a clear error, not a 400 from the server. */
export function parseImportFile(text: string): LibraryEntry[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('That file is not valid JSON')
  }
  const entries = Array.isArray(data) ? data : (data as { entries?: unknown })?.entries
  if (!Array.isArray(entries)) throw new Error('Expected a PromptFixer export with an "entries" list')
  return entries as LibraryEntry[]
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function importSummary(r: ImportResult): string {
  if (!r.total) return 'That file has no prompts to import'
  if (!r.imported) return `Nothing new to import · all ${r.total} already saved or malformed`
  const skipped = r.skipped ? ` · ${r.skipped} skipped (already saved or malformed)` : ''
  return `Imported ${plural(r.imported, 'prompt')}${skipped}`
}

// --- few-shot ------------------------------------------------------------------------

/** Suffix for the "What changed" line; older servers omit examplesUsed. */
export function learnedNote(meta: { examplesUsed?: number }): string {
  const n = meta.examplesUsed ?? 0
  return n > 0 ? ` · learned from ${plural(n, 'saved example')}` : ''
}

// --- marks on the rewrite ---------------------------------------------------------------

export type MarkKind = 'keep' | 'change'

/** A highlighted range of the rewrite: character offsets into fixedPrompt, `end` exclusive. */
export interface Mark {
  start: number
  end: number
  kind: MarkKind
}

/**
 * The server reads at most this many passages of a kind (MAX_MARKS in
 * server/index.js) and silently drops the rest. The bar stops at the same
 * number, so its count never promises the model more than it is shown.
 */
export const MAX_MARKS = 20

/** One shared empty list, so "no marks" never looks like a change to a memo or an effect. */
export const NO_MARKS: Mark[] = []

/**
 * The one place that decides what marking a range does: the new list, or why
 * there is none. addMark acts on it and markRefusedAtCap explains it, so the
 * button can never refuse a press the reducer would take, nor offer one it drops.
 */
function placeMark(marks: Mark[], mark: Mark, text: string): Mark[] | 'blank' | 'full' {
  let start = Math.max(0, Math.min(mark.start, mark.end))
  let end = Math.min(text.length, Math.max(mark.start, mark.end))
  while (start < end && /\s/.test(text[start])) start++
  while (end > start && /\s/.test(text[end - 1])) end--
  // Written this way round so a NaN offset is ignored too.
  if (!(start < end)) return 'blank'
  const untouched = marks.filter((m) => m.end <= start || m.start >= end)
  // Counted after the overlaps are gone: redrawing one of twenty marks is still twenty.
  if (untouched.filter((m) => m.kind === mark.kind).length >= MAX_MARKS) return 'full'
  return [...untouched, { start, end, kind: mark.kind }].sort((a, b) => a.start - b.start)
}

/**
 * Mark a selected range. It is clamped to the text and loses the whitespace at
 * both ends (a double-click drags the trailing space along); if nothing is left
 * the same array comes back, so React skips the render. Every mark the new one
 * touches is dropped: the newest decision wins. A mark that would take its kind
 * past MAX_MARKS is refused the same way.
 */
export function addMark(marks: Mark[], mark: Mark, text: string): Mark[] {
  const placed = placeMark(marks, mark, text)
  return typeof placed === 'string' ? marks : placed
}

/** Whether `kind` already holds all the marks the server will read. */
export function markCapReached(marks: Mark[], kind: MarkKind): boolean {
  return markCounts(marks)[kind] >= MAX_MARKS
}

/**
 * Whether addMark would refuse this range because its kind is full. A full kind
 * still takes a range that replaces or merges marks of its own, and a range of
 * nothing but whitespace is not refused for the cap: removing a mark would not
 * make it markable, so the cap's tooltip would be a lie there.
 */
export function markRefusedAtCap(marks: Mark[], mark: Mark, text: string): boolean {
  return placeMark(marks, mark, text) === 'full'
}

/**
 * What a marking button shows for the live selection (null: none in the
 * rewrite). With nothing selected a full kind still says why in its tooltip.
 */
export function markButton(
  marks: Mark[],
  selection: { start: number; end: number } | null,
  kind: MarkKind,
  text: string
): { disabled: boolean; title: string | undefined } {
  const full = selection ? markRefusedAtCap(marks, { ...selection, kind }, text) : markCapReached(marks, kind)
  return { disabled: !selection || full, title: full ? markCapTitle(kind) : undefined }
}

/** The tooltip of a marking button that is disabled because its kind is full. */
export function markCapTitle(kind: MarkKind): string {
  const what = kind === 'keep' ? 'kept' : 'to change'
  return `${MAX_MARKS} passages ${what} is the most the model is shown. Remove one to mark another.`
}

export function removeMark(marks: Mark[], index: number): Mark[] {
  return index >= 0 && index < marks.length ? marks.filter((_, i) => i !== index) : marks
}

export interface MarkSegment {
  text: string
  /** null for the plain text between marks. */
  kind: MarkKind | null
  /** Position in `marks`, or -1 for plain text. */
  index: number
}

/**
 * The rewrite cut into plain and marked runs, in order. The runs always join
 * back to exactly `text`: `pre.output` has to hold the prompt character for
 * character, so a mark that does not fit (made for another text, or overlapping
 * an earlier one) is left out rather than allowed to bend the text.
 */
export function markSegments(text: string, marks: Mark[]): MarkSegment[] {
  const out: MarkSegment[] = []
  let at = 0
  const ordered = marks.map((m, index) => ({ ...m, index })).sort((a, b) => a.start - b.start)
  for (const m of ordered) {
    if (!(m.start < m.end) || m.start < at || m.end > text.length) continue
    if (m.start > at) out.push({ text: text.slice(at, m.start), kind: null, index: -1 })
    out.push({ text: text.slice(m.start, m.end), kind: m.kind, index: m.index })
    at = m.end
  }
  if (at < text.length) out.push({ text: text.slice(at), kind: null, index: -1 })
  return out
}

export function markCounts(marks: Mark[]): { keep: number; change: number } {
  const keep = marks.filter((m) => m.kind === 'keep').length
  return { keep, change: marks.length - keep }
}

/**
 * What a screen reader hears on a highlight: the verdict, the passage, and that
 * activating it removes it. The passage is never clipped: an aria-label replaces
 * the element's content, so whatever is cut here is text of the rewrite that
 * assistive technology can no longer reach.
 */
export function markLabel(kind: MarkKind, passage: string): string {
  const what = kind === 'keep' ? 'Marked to keep' : 'Marked to change'
  return `${what}: “${passage.replace(/\s+/g, ' ').trim()}”. Activate to remove this mark.`
}

/** The marks the user made, and the one rewrite they were made on. */
export interface MarkedResult {
  result: FixResult
  marks: Mark[]
}

/**
 * The marks to paint and to refine with: only ever those made on the rewrite
 * being shown. While their result waits behind "Show last fix" nothing is
 * shown, so there is nothing to mark or to fix again with either.
 */
export function shownMarks(marked: MarkedResult | null, active: FixResult | null): Mark[] {
  return marked && marked.result === active ? marked.marks : NO_MARKS
}

/**
 * What is left of the marks once `selected` is the history's selected result.
 * They die with any change of selection: a new fix or refine, a history step,
 * or Apply, Clear, an example or a library load parking it (null). A result
 * that is merely hidden because the editor moved on is still selected, so one
 * keystroke in the editor does not cost the user their marks. The same object
 * comes back when nothing dies, so React skips the render.
 */
export function marksAfterSelect(marked: MarkedResult | null, selected: FixResult | null): MarkedResult | null {
  return marked && marked.result === selected ? marked : null
}

/**
 * Ctrl+Enter is the app-wide "fix from scratch" shortcut, and a fresh fix
 * throws the marks away, so the marking UI keeps the key to itself, but only
 * while there are marks to lose. With none it has to reach the app-wide handler,
 * as it did before the rewrite could take focus.
 */
export function holdsFixShortcut(e: { key: string; ctrlKey: boolean; metaKey: boolean }, marks: Mark[]): boolean {
  return marks.length > 0 && (e.ctrlKey || e.metaKey) && e.key === 'Enter'
}

/**
 * The `feedback` field of POST /api/fix, or null when there is nothing to send.
 * The same words marked twice are one passage to the model.
 */
export function feedbackPayload(text: string, marks: Mark[]): FixFeedback | null {
  const passages = (kind: MarkKind) => [
    ...new Set(marks.filter((m) => m.kind === kind).map((m) => text.slice(m.start, m.end)).filter(Boolean)),
  ]
  const keep = passages('keep')
  const change = passages('change')
  return keep.length || change.length ? { previous: text, keep, change } : null
}

/**
 * Gate for "Fix again with my marks". Same rules as canFix, but `g.prompt` is
 * the marked result's original: a refine is measured against that, whatever
 * the editor holds by now.
 */
export function canRefine(g: FixGate, marks: Mark[]): boolean {
  return marks.length > 0 && canFix(g)
}

/**
 * Suffix for the "What changed" line after a refine. It counts the marks the
 * rewrite actually honoured, so it never claims more than the warning admits.
 */
export function refinedNote(meta: { feedback?: FixResult['meta']['feedback'] }): string {
  const f = meta.feedback
  if (!f) return ''
  const kept = Math.max(0, f.keep - (f.missingKeep?.length ?? 0))
  const changed = Math.max(0, f.change - (f.unchangedChange?.length ?? 0))
  return ` · refined with your marks (${kept} kept, ${changed} changed)`
}
