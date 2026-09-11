/**
 * Group I — Showing what changed.
 * Scenarios: acceptance/features/I-diff.feature. Run: npm run test:acceptance
 *
 * Seam note: the Diff tab is a browser surface, so until the Playwright
 * harness exists these scenarios drive the diff at the library boundary the
 * tab is built on (src/lib/diff.ts). They assert what the user would see —
 * which words are marked — not how the algorithm works.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { diffStats, diffText } from '../src/lib/diff.ts'

const words = (n, prefix = 'w') => Array.from({ length: n }, (_, i) => `${prefix}${i}${i % 9 === 8 ? '.' : ''}`).join(' ')
const marked = (tokens, type) =>
  tokens
    .filter((t) => t.type === type)
    .map((t) => t.value.trim())
    .filter(Boolean)

test('I1 — The user can see exactly what changed and nothing is hidden', () => {
  const before = 'write a blog post about our new feature, make it good and professional.'
  const after = 'Write a 300-word blog post about our new feature for developers.'
  const { tokens, degraded } = diffText(before, after)
  assert.equal(degraded, false)
  assert.ok(marked(tokens, 'del').join(' ').includes('good'), 'removed words are marked as removed')
  assert.ok(marked(tokens, 'add').join(' ').includes('300-word'), 'added words are marked as added')
  assert.ok(marked(tokens, 'same').join(' ').includes('blog post about our new feature'), 'kept words are kept')

  const identical = diffText(before, before)
  assert.deepEqual(diffStats(identical.tokens), { added: 0, removed: 0, unchanged: before.split(/\s+/).length })
})

test('I2 — One changed word in a long document is one changed word', () => {
  const long = words(1500)
  const inserted = long.split(' ')
  inserted.splice(700, 0, 'INSERTED')
  let started = Date.now()
  const one = diffText(long, inserted.join(' '))
  assert.ok(Date.now() - started < 1000, 'renders quickly')
  assert.deepEqual(marked(one.tokens, 'add'), ['INSERTED'])
  assert.deepEqual(marked(one.tokens, 'del'), [])
  assert.equal(one.degraded, false)

  const lines = Array.from({ length: 8000 }, (_, i) => `line ${i} of the document.`)
  const changed = [...lines]
  changed[4000] = 'line 4000 was rewritten entirely.'
  started = Date.now()
  const many = diffText(lines.join('\n'), changed.join('\n'))
  assert.ok(Date.now() - started < 2000, 'thousands of lines still render quickly')
  assert.equal(diffStats(many.tokens).removed <= 6, true, 'only the changed line is touched')
})

test('I3 — A region too large to align is reported, not hidden', () => {
  const before = words(6000, 'a')
  const after = words(6000, 'b')
  const { tokens, degraded } = diffText(before, after)
  assert.equal(degraded, true, 'the user is told this region was replaced wholesale')
  const stats = diffStats(tokens)
  assert.equal(stats.removed, 6000)
  assert.equal(stats.added, 6000)
  assert.ok(tokens.length > 0, 'nothing is shown as empty')
})
