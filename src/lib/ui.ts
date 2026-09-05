/**
 * Decision logic lifted out of the components so it can be unit-tested from
 * node:test without a DOM (see server/diff.test.js). Keep this file free of
 * React and of TypeScript syntax that Node cannot strip (enums, namespaces,
 * parameter properties).
 */
import type {
  Analysis,
  ExamplePrompt,
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
