/**
 * Front-end regression checks that need no DOM: the word diff, the UI
 * decision helpers in src/lib/ui.ts, and the colour tokens in src/styles.css.
 * Node strips the TypeScript types on import, so the .ts sources are loaded
 * directly. Run with: npm test
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { diffStats, diffText, diffWords } from '../src/lib/diff.ts'
import {
  activatesEntry,
  canFix,
  localIdle,
  localTierAction,
  resultView,
  warningHeadline,
  warningKind,
} from '../src/lib/ui.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// --- diff --------------------------------------------------------------------

/** N words on one line, a full stop every ninth word so sentence chunking has something to grip. */
const paragraph = (n) => Array.from({ length: n }, (_, i) => `w${i}${i % 9 === 8 ? '.' : ''}`).join(' ')
const insertAt = (text, index, word) => {
  const words = text.split(' ')
  words.splice(index, 0, word)
  return words.join(' ')
}
const join = (tokens, skip) => tokens.filter((t) => t.type !== skip).map((t) => t.value).join('')

test('diff: a one-word insertion stays a one-word diff far beyond 1300 words', () => {
  for (const n of [500, 1300, 1400, 3000, 8000]) {
    const before = paragraph(n)
    const after = insertAt(before, Math.floor(n / 2), 'INSERTED')
    const { tokens, degraded } = diffText(before, after)
    assert.deepEqual(diffStats(tokens), { added: 1, removed: 0, unchanged: n }, `${n} words`)
    assert.equal(degraded, false, `${n} words should not degrade`)
    // The token stream must reproduce both sides exactly.
    assert.equal(join(tokens, 'add'), before)
    assert.equal(join(tokens, 'del'), after)
  }
})

test('diff: edits at both ends of a long single paragraph are diffed by word', () => {
  const n = 6000
  const before = paragraph(n)
  const after = insertAt(insertAt(before, n - 10, 'LATE'), 10, 'EARLY')
  const started = performance.now()
  const { tokens, degraded } = diffText(before, after)
  assert.ok(performance.now() - started < 500, 'stays fast')
  assert.deepEqual(diffStats(tokens), { added: 2, removed: 0, unchanged: n })
  assert.equal(degraded, false)
  const added = tokens.filter((t) => t.type === 'add').map((t) => t.value.trim())
  assert.deepEqual(added, ['EARLY', 'LATE'])
})

test('diff: 8000-line inputs with one changed line finish quickly at word level', () => {
  const before = Array.from({ length: 8000 }, (_, i) => `line ${i} here`).join('\n')
  const after = before.replace('line 4000 here', 'line 4000 there')
  const started = performance.now()
  const { tokens, degraded } = diffText(before, after)
  assert.ok(performance.now() - started < 500)
  assert.equal(degraded, false)
  assert.deepEqual(diffStats(tokens), { added: 1, removed: 1, unchanged: 8000 * 3 - 1 })
})

test('diff: a region too big to align by word is reported, not hidden', () => {
  // No sentence boundaries and nothing in common: one chunk each, far over budget.
  const before = Array.from({ length: 6000 }, (_, i) => `a${i}`).join(' ')
  const after = Array.from({ length: 6000 }, (_, i) => `b${i}`).join(' ')
  const { tokens, degraded } = diffText(before, after)
  assert.equal(degraded, true)
  assert.deepEqual(diffStats(tokens), { added: 6000, removed: 6000, unchanged: 0 })
  assert.equal(join(tokens, 'add'), before)
  assert.equal(join(tokens, 'del'), after)
})

test('diff: small inputs, identical inputs and the legacy token API', () => {
  assert.deepEqual(diffText('', ''), { tokens: [], degraded: false })
  assert.deepEqual(diffText('same text', 'same text'), {
    tokens: [{ type: 'same', value: 'same text' }],
    degraded: false,
  })
  const tokens = diffWords('write a blog post', 'write one blog post')
  assert.deepEqual(diffStats(tokens), { added: 1, removed: 1, unchanged: 3 })
  assert.deepEqual(tokens, [
    { type: 'same', value: 'write ' },
    { type: 'del', value: 'a' },
    { type: 'add', value: 'one' },
    { type: 'same', value: ' blog post' },
  ])
})

// --- warning banner headline (finding 15) ------------------------------------

test('ui: warning headline follows warningKind and falls back to the text', () => {
  assert.equal(warningHeadline({ warning: 'x', warningKind: 'leak' }), 'The model copied its instructions into the rewrite')
  assert.equal(warningHeadline({ warning: 'x', warningKind: 'retention' }), 'Rewrote more than the strength allows')
  assert.equal(warningHeadline({ warning: 'x', warningKind: 'growth' }), 'Added more than the strength allows')

  const leak =
    'The model copied its instructions into the rewrite twice; the boilerplate was stripped, so check the result carefully.'
  const retention =
    'The model rewrote more than "Balanced" allows — only 12% of your words survived. Check the Diff tab; try Light touch, or add an instruction about what to keep.'
  assert.equal(warningKind({ warning: leak }), 'leak')
  assert.equal(warningKind({ warning: retention }), 'retention')
  assert.equal(warningKind({ warning: 'The model added far more than "Light touch" allows.' }), 'growth')
  assert.equal(warningHeadline({ warning: leak }), 'The model copied its instructions into the rewrite')
})

// --- local tier sync (finding 29) --------------------------------------------

const status = (over = {}) => ({
  tier: 'default',
  phase: 'missing',
  downloaded: false,
  loaded: false,
  catalog: [
    { id: 'lite', downloaded: true },
    { id: 'default', downloaded: false },
  ],
  ...over,
})

test('ui: a remembered tier that differs from the server is pushed, not just displayed', () => {
  assert.deepEqual(localTierAction('lite', status()), { kind: 'push', tier: 'lite' })
  assert.deepEqual(localTierAction('default', status()), { kind: 'none' })
  assert.deepEqual(localTierAction('', status()), { kind: 'adopt', tier: 'default' })
  assert.deepEqual(localTierAction('nope', status()), { kind: 'adopt', tier: 'default' })
  // In-flight downloads and loads are not interrupted by a tier switch.
  assert.deepEqual(localTierAction('lite', status({ phase: 'downloading' })), { kind: 'none' })
  assert.deepEqual(localTierAction('lite', status({ phase: 'loading' })), { kind: 'none' })
})

// --- fix gating shared by button and shortcut (findings 31, 35) --------------

test('ui: canFix blocks a missing/downloading local model and the cancel settle window', () => {
  const base = { prompt: 'Write a poem', model: 'lite', provider: 'local', fixing: false, cancelling: false }
  assert.equal(canFix({ ...base, localStatus: status() }), false, 'model missing')
  assert.equal(canFix({ ...base, localStatus: status({ downloaded: true, phase: 'downloading' }) }), false)
  assert.equal(canFix({ ...base, localStatus: null }), false, 'status unknown')
  assert.equal(canFix({ ...base, localStatus: status({ downloaded: true, phase: 'downloaded' }) }), true)
  assert.equal(canFix({ ...base, localStatus: status({ downloaded: true, phase: 'ready' }), cancelling: true }), false)
  assert.equal(canFix({ ...base, localStatus: status({ downloaded: true, phase: 'ready' }), fixing: true }), false)
  assert.equal(canFix({ ...base, provider: 'openai', model: '', localStatus: null }), false, 'no model')
  assert.equal(canFix({ ...base, provider: 'openai', prompt: '   ', localStatus: null }), false, 'blank prompt')
  assert.equal(canFix({ ...base, provider: 'openai', localStatus: null }), true)
})

test('ui: the cancel window closes only when status reports the server idle', () => {
  assert.equal(localIdle(status({ busy: true })), false)
  assert.equal(localIdle(status({ busy: false })), true)
  // Older servers never report busy; treat that as idle so Fix is not wedged.
  assert.equal(localIdle(status()), true)
})

// --- stale result after editing (finding 32) ---------------------------------

const analysisOf = (score) => ({ score, issues: [] })
const fix = {
  original: 'A',
  fixedPrompt: 'A fixed',
  before: analysisOf(40),
  after: analysisOf(90),
  changes: [{ type: 'x', what: 'y', why: 'z' }],
}

test('ui: editing the prompt swaps the Issues tab to the live analysis and parks the result', () => {
  const live = analysisOf(55)
  const current = resultView(fix, live, 'A', false)
  assert.equal(current.edited, false)
  assert.equal(current.shown, fix.after)
  assert.equal(current.compareTo, fix.before)
  assert.equal(current.active, fix)

  const edited = resultView(fix, live, 'AB', false)
  assert.equal(edited.edited, true)
  assert.equal(edited.shown, live, 'Issues tab follows the editor')
  assert.equal(edited.compareTo, null, 'no "was N" delta against an unrelated score')
  assert.equal(edited.active, null, 'Fixed/Diff/Changes hide behind the control')

  const peek = resultView(fix, live, 'AB', true)
  assert.equal(peek.active, fix, '"Show last fix" brings the result back')
  assert.equal(peek.shown, live, 'but the Issues tab still scores the editor')

  assert.equal(resultView(null, live, 'AB', true).active, null)
})

// --- library entry keyboard activation (finding 34) --------------------------

test('ui: Enter on the nested Delete button does not activate the entry', () => {
  const wrapper = {}
  const deleteButton = {}
  assert.equal(activatesEntry({ key: 'Enter', target: deleteButton, currentTarget: wrapper }), false)
  assert.equal(activatesEntry({ key: ' ', target: deleteButton, currentTarget: wrapper }), false)
  assert.equal(activatesEntry({ key: 'Enter', target: wrapper, currentTarget: wrapper }), true)
  assert.equal(activatesEntry({ key: ' ', target: wrapper, currentTarget: wrapper }), true)
  assert.equal(activatesEntry({ key: 'a', target: wrapper, currentTarget: wrapper }), false)
})

// --- faint text contrast (finding 36) ----------------------------------------

function cssTokens() {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')
  const root = css.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
  const tokens = {}
  for (const [, name, value] of root.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)) tokens[name] = value
  return tokens
}

function luminance(hex) {
  const channel = (c) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(fg, bg) {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a)
  return (hi + 0.05) / (lo + 0.05)
}

test('styles: --text-faint meets WCAG AA (4.5:1) on every surface it is used on', () => {
  const t = cssTokens()
  assert.ok(t['--text-faint'], 'token present')
  for (const bg of ['--bg', '--bg-soft', '--panel', '--panel-2']) {
    const ratio = contrast(t['--text-faint'], t[bg])
    assert.ok(ratio >= 4.5, `--text-faint on ${bg} is ${ratio.toFixed(2)}:1, needs 4.5:1`)
  }
})
