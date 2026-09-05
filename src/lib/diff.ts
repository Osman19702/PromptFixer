export type DiffOp = 'same' | 'add' | 'del'

export interface DiffToken {
  type: DiffOp
  value: string
}

export interface DiffResult {
  tokens: DiffToken[]
  /**
   * True when some part of the text was too long to compare word by word and
   * is shown as whole sentences removed and added instead. The UI must say so
   * rather than let a coarse diff pass for a word-level one.
   */
  degraded: boolean
}

/** Split into words, punctuation and whitespace so the diff lands on word boundaries. */
function tokenize(text: string): string[] {
  return text.match(/\s+|[\p{L}\p{N}'’_-]+|[^\s\p{L}\p{N}]/gu) ?? []
}

/**
 * Sentence-or-line chunks that concatenate back to the original text. A
 * single-paragraph prompt still gets many chunks, which is what keeps long
 * inputs diffable at the word level (see diffText).
 */
function splitChunks(text: string): string[] {
  return text.split(/(?<=[.!?]["'”’)\]]*\s+)|(?<=\n)/u).filter(Boolean)
}

/** Classic LCS backtrack. Typed array keeps the table cheap enough for real prompts. */
function lcsDiff(a: string[], b: string[]): DiffToken[] {
  const n = a.length
  const m = b.length
  // Uint16 halves the table; both sides are capped well under 65k tokens.
  const table = new Uint16Array((n + 1) * (m + 1))
  const at = (i: number, j: number) => i * (m + 1) + j

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[at(i, j)] =
        a[i] === b[j]
          ? table[at(i + 1, j + 1)] + 1
          : Math.max(table[at(i + 1, j)], table[at(i, j + 1)])
    }
  }

  const out: DiffToken[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', value: a[i] })
      i++
      j++
    } else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) {
      out.push({ type: 'del', value: a[i] })
      i++
    } else {
      out.push({ type: 'add', value: b[j] })
      j++
    }
  }
  while (i < n) out.push({ type: 'del', value: a[i++] })
  while (j < m) out.push({ type: 'add', value: b[j++] })

  return out
}

/** Strip the shared head and tail so the quadratic step only sees what changed. */
function trimCommon<T>(a: T[], b: T[]): { prefix: T[]; suffix: T[]; a: T[]; b: T[] } {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  ) {
    end++
  }
  return {
    prefix: a.slice(0, start),
    suffix: a.slice(a.length - end),
    a: a.slice(start, a.length - end),
    b: b.slice(start, b.length - end),
  }
}

/**
 * Largest side of a word-level LCS table: about 2000 words once whitespace and
 * punctuation tokens are counted, a 32 MB Uint16 table. Counting tokens rather
 * than words keeps punctuation-only runs from blowing past the Uint16 range.
 */
const MAX_TOKENS = 4000
/** Chunk-level LCS is the coarse fallback; past this we give up on alignment. */
const MAX_CHUNKS = 4000

/** Coalesce neighbouring tokens of the same kind so the view gets fewer nodes. */
function compact(tokens: DiffToken[]): DiffToken[] {
  const out: DiffToken[] = []
  for (const t of tokens) {
    if (!t.value) continue
    const last = out[out.length - 1]
    if (last && last.type === t.type) last.value += t.value
    else out.push({ type: t.type, value: t.value })
  }
  return out
}

/** Word diff of two already-trimmed token lists, or null when too big for the table. */
function wordDiff(a: string[], b: string[]): DiffToken[] | null {
  const t = trimCommon(a, b)
  if (t.a.length > MAX_TOKENS || t.b.length > MAX_TOKENS) return null
  return [
    ...t.prefix.map((value): DiffToken => ({ type: 'same', value })),
    ...lcsDiff(t.a, t.b),
    ...t.suffix.map((value): DiffToken => ({ type: 'same', value })),
  ]
}

/**
 * Word-level diff. Long inputs are first aligned by sentence, then each run of
 * changed sentences is diffed word by word, so a one-word edit in a
 * multi-thousand-word paragraph still shows as one word. Only a single run too
 * large for the word table degrades, and the result says so.
 */
export function diffText(before: string, after: string): DiffResult {
  if (before === after) {
    return { tokens: before ? [{ type: 'same', value: before }] : [], degraded: false }
  }

  const direct = wordDiff(tokenize(before), tokenize(after))
  if (direct) return { tokens: compact(direct), degraded: false }

  const chunks = trimCommon(splitChunks(before), splitChunks(after))
  const out: DiffToken[] = chunks.prefix.map((value) => ({ type: 'same', value }))
  let degraded = false

  if (chunks.a.length > MAX_CHUNKS || chunks.b.length > MAX_CHUNKS) {
    out.push({ type: 'del', value: chunks.a.join('') }, { type: 'add', value: chunks.b.join('') })
    degraded = true
  } else {
    // Each run of removed chunks followed by added chunks is one edit region.
    const coarse = lcsDiff(chunks.a, chunks.b)
    let dels: string[] = []
    let adds: string[] = []
    const flush = () => {
      if (!dels.length && !adds.length) return
      const fine = wordDiff(tokenize(dels.join('')), tokenize(adds.join('')))
      if (fine) out.push(...fine)
      else {
        out.push({ type: 'del', value: dels.join('') }, { type: 'add', value: adds.join('') })
        degraded = true
      }
      dels = []
      adds = []
    }
    for (const t of coarse) {
      if (t.type === 'same') {
        flush()
        out.push(t)
      } else if (t.type === 'del') {
        // A deletion after additions starts a new region.
        if (adds.length) flush()
        dels.push(t.value)
      } else {
        adds.push(t.value)
      }
    }
    flush()
  }

  out.push(...chunks.suffix.map((value): DiffToken => ({ type: 'same', value })))
  return { tokens: compact(out), degraded }
}

/** Token list only; kept for callers that don't care whether the diff degraded. */
export function diffWords(before: string, after: string): DiffToken[] {
  return diffText(before, after).tokens
}

export function diffStats(tokens: DiffToken[]) {
  let added = 0
  let removed = 0
  let unchanged = 0
  for (const t of tokens) {
    const words = (t.value.match(/[\p{L}\p{N}'’_-]+/gu) ?? []).length
    if (t.type === 'add') added += words
    else if (t.type === 'del') removed += words
    else unchanged += words
  }
  return { added, removed, unchanged }
}
