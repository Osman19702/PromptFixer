/**
 * Prompt library / history: a single JSON file, written atomically.
 *
 * Server-side rather than localStorage so the library survives a cleared
 * browser and can be backed up or version-controlled by the user.
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { contentWords } from './metaprompt.js'

// Packaged desktop builds run from a read-only archive, so Electron points this
// at the per-user data directory instead.
const DIR =
  process.env.PROMPTFIXER_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'data')
const FILE = path.join(DIR, 'library.json')
const MAX_ENTRIES = 500

let writeQueue = Promise.resolve()

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v))

/**
 * The file is meant to be hand-edited and version-controlled, so it may hold
 * nulls, numbers where strings belong, or entries without an id. Normalise
 * once here so list/get/save/remove never have to defend against shape.
 */
function sanitize(entries) {
  return entries
    .filter((e) => e && typeof e === 'object' && !Array.isArray(e) && typeof e.id === 'string')
    .map((e) => ({
      ...e,
      title: str(e.title),
      original: str(e.original),
      fixed: str(e.fixed),
      tags: Array.isArray(e.tags) ? e.tags.filter((t) => t != null).map(String) : [],
    }))
}

async function readAll() {
  try {
    const raw = await fs.readFile(FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return sanitize(Array.isArray(parsed?.entries) ? parsed.entries : [])
  } catch (err) {
    if (err.code === 'ENOENT') return []
    if (err instanceof SyntaxError) {
      // Corrupt file: move it aside rather than silently losing the user's data.
      await fs.rename(FILE, `${FILE}.corrupt-${Date.now()}`).catch(() => {})
      return []
    }
    throw err
  }
}

// Windows refuses to rename over a file that anything has open at that instant
// — an indexer, antivirus, a backup tool reading library.json — with EPERM,
// EBUSY or EACCES. The reader is gone milliseconds later, so the rename waits
// and tries again rather than turn somebody else's read into a lost save.
// Many short waits, about a second in all: against a reader that keeps coming
// back, every try is another draw, and long waits buy no better odds.
const RENAME_RETRY_MS = [5, 10, 20, 40, ...Array(18).fill(50)]
const HELD_OPEN = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** fs.rename that outlasts a target briefly held open. `rename` and `waits` are there for the test. */
export async function renameOver(from, to, { rename = fs.rename, waits = RENAME_RETRY_MS } = {}) {
  for (let i = 0; ; i++) {
    try {
      return await rename(from, to)
    } catch (err) {
      if (!HELD_OPEN.has(err.code) || i >= waits.length) throw err
      await new Promise((resolve) => setTimeout(resolve, waits[i]))
    }
  }
}

async function writeAll(entries) {
  await fs.mkdir(DIR, { recursive: true })
  const tmp = `${FILE}.tmp-${process.pid}`
  await fs.writeFile(tmp, JSON.stringify({ version: 1, entries }, null, 2), 'utf8')
  try {
    await renameOver(tmp, FILE)
  } catch (err) {
    // The save is lost either way; do not leave its temp file next to the library as well.
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/** Serialise mutations so two concurrent saves cannot clobber each other. */
function mutate(fn) {
  const next = writeQueue.then(async () => {
    const entries = await readAll()
    const result = await fn(entries)
    await writeAll(result.entries)
    return result.value
  })
  writeQueue = next.catch(() => {})
  return next
}

// Default to the retention cap: the drawer has no paging, so anything below
// MAX_ENTRIES would make the oldest saved prompts unreachable from the UI.
export async function list({ query = '', limit = MAX_ENTRIES } = {}) {
  const entries = await readAll()
  const q = str(query).trim().toLowerCase()
  const filtered = q
    ? entries.filter(
        (e) =>
          (e.title || '').toLowerCase().includes(q) ||
          (e.original || '').toLowerCase().includes(q) ||
          (e.fixed || '').toLowerCase().includes(q) ||
          (e.tags || []).some((t) => t.toLowerCase().includes(q))
      )
    : entries
  return filtered.slice(0, limit)
}

export async function get(id) {
  const entries = await readAll()
  return entries.find((e) => e.id === id) || null
}

function deriveTitle(entry) {
  // Coerce first: a numeric or object title from the API must not crash save().
  const source = (str(entry.title) || str(entry.original)).replace(/\s+/g, ' ').trim()
  if (!source) return 'Untitled prompt'
  return source.length > 70 ? `${source.slice(0, 70)}…` : source
}

/** The stored shape: `input` over `base`, every field coerced. Shared by save() and importEntries(). */
function build(base, input, now) {
  return {
    ...base,
    title: deriveTitle({ ...base, ...input }),
    original: String(input.original ?? base.original ?? ''),
    fixed: String(input.fixed ?? base.fixed ?? ''),
    summary: String(input.summary ?? base.summary ?? ''),
    options: input.options ?? base.options ?? {},
    scoreBefore: input.scoreBefore ?? base.scoreBefore ?? null,
    scoreAfter: input.scoreAfter ?? base.scoreAfter ?? null,
    provider: input.provider ?? base.provider ?? null,
    model: input.model ?? base.model ?? null,
    tags: Array.isArray(input.tags) ? input.tags.map(String).slice(0, 12) : base.tags ?? [],
    favorite: typeof input.favorite === 'boolean' ? input.favorite : base.favorite ?? false,
    updatedAt: now,
  }
}

export async function save(input) {
  const now = new Date().toISOString()
  return mutate(async (entries) => {
    const existingIndex = input.id ? entries.findIndex((e) => e.id === input.id) : -1
    const base = existingIndex >= 0 ? entries[existingIndex] : { id: randomUUID(), createdAt: now }

    const entry = build(base, input, now)

    const nextEntries =
      existingIndex >= 0
        ? entries.map((e, i) => (i === existingIndex ? entry : e))
        : [entry, ...entries].slice(0, MAX_ENTRIES)

    return { entries: nextEntries, value: entry }
  })
}

/**
 * An export from another machine is user data too, but it is also the one
 * place a whole file of foreign shapes arrives at once, so the bar is a
 * little higher than for the hand-edited file: an id plus both texts.
 */
const importable = (e) =>
  e &&
  typeof e === 'object' &&
  !Array.isArray(e) &&
  typeof e.id === 'string' &&
  e.id.trim() !== '' &&
  typeof e.original === 'string' &&
  typeof e.fixed === 'string'

/**
 * Merge exported entries into the library. An id that already exists is
 * skipped rather than overwritten — the copy on this machine may have been
 * edited since the export — and the retention cap still holds.
 */
export async function importEntries(input) {
  const candidates = Array.isArray(input) ? input : []
  const now = new Date().toISOString()
  return mutate(async (entries) => {
    const known = new Set(entries.map((e) => e.id))
    const added = []
    for (const raw of candidates) {
      if (!importable(raw) || known.has(raw.id) || entries.length + added.length >= MAX_ENTRIES) continue
      known.add(raw.id)
      const createdAt = typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : now
      const entry = build({ id: raw.id, createdAt }, raw, now)
      // Keep the export's own timestamp: the entry is old, only its arrival is new.
      if (typeof raw.updatedAt === 'string' && raw.updatedAt) entry.updatedAt = raw.updatedAt
      added.push(entry)
    }
    // The drawer lists newest first with no other ordering, so an imported
    // entry has to land where its date puts it, not at the top or the bottom.
    const merged = [...entries, ...added].sort((a, b) => str(b.createdAt).localeCompare(str(a.createdAt)))
    return {
      entries: merged,
      value: { imported: added.length, skipped: candidates.length - added.length, total: merged.length },
    }
  })
}

/** Fraction of distinct words two sets share; 0 when either is empty. */
function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared / (a.size + b.size - shared)
}

// Enough to break near-ties in favour of the same task type, not enough to
// outrank a clearly closer prompt from another one.
const SAME_INTENT_BONUS = 0.1

// A saved score may be a number, a numeric string from a hand-edited file, or
// null when the entry was saved without a lint. Number(null) is 0, which would
// let "no before score" read as "improved from zero" — so unknown stays NaN.
const score = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v))

/**
 * Earlier rewrites worth showing the model as examples for `prompt`: the
 * entries whose original shares the most vocabulary with it, among those the
 * user kept after the rewrite scored higher than the original. The same
 * prompt as an example of itself would just be the answer key, so it is
 * excluded. Pure and cheap: word sets only, no model.
 */
export async function similar(prompt, { intent, limit = 2 } = {}) {
  const target = str(prompt).trim()
  const words = contentWords(target)
  if (!words.size) return []
  const entries = await readAll()
  return entries
    .filter(
      (e) =>
        e.original.trim() !== '' &&
        e.fixed.trim() !== '' &&
        e.original.trim() !== target &&
        score(e.scoreAfter) > score(e.scoreBefore)
    )
    .map((e) => {
      const overlap = jaccard(words, contentWords(e.original))
      const sameIntent = !!intent && e.options && typeof e.options === 'object' && e.options.intent === intent
      return { entry: e, overlap, rank: overlap + (sameIntent ? SAME_INTENT_BONUS : 0) }
    })
    .filter((s) => s.overlap > 0)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, Math.max(0, Number(limit) || 0))
    .map((s) => s.entry)
}

export async function remove(id) {
  return mutate(async (entries) => {
    const next = entries.filter((e) => e.id !== id)
    return { entries: next, value: { removed: next.length !== entries.length } }
  })
}

export async function clear() {
  return mutate(async () => ({ entries: [], value: { cleared: true } }))
}
