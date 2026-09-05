/**
 * Prompt library store: retention vs listing, and tolerance for a hand-edited
 * library.json. Uses a private data dir per run so a dev server can never flake it.
 * Run with: npm test
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptfixer-store-'))
process.env.PROMPTFIXER_DATA_DIR = dataDir
const FILE = path.join(dataDir, 'library.json')

const store = await import('./store.js')

after(() => fs.rmSync(dataDir, { recursive: true, force: true }))

test('list() returns everything the store keeps, not the first 100', async () => {
  await store.clear()
  for (let i = 1; i <= 101; i++) await store.save({ original: `entry number ${i}`, favorite: i === 1 })
  const all = await store.list()
  assert.equal(all.length, 101)
  // Newest first; the oldest (and favourite) entry is still reachable.
  assert.equal(all[0].original, 'entry number 101')
  assert.equal(all.at(-1).original, 'entry number 1')
  assert.equal(all.at(-1).favorite, true)
  // An explicit limit still works.
  assert.equal((await store.list({ limit: 5 })).length, 5)
})

test('save() tolerates non-string fields instead of crashing', async () => {
  await store.clear()
  const numericTitle = await store.save({ title: 5, original: 'body' })
  assert.equal(numericTitle.title, '5')
  const numericOriginal = await store.save({ original: 123 })
  assert.equal(numericOriginal.title, '123')
  assert.equal(numericOriginal.original, '123')
  const objectTitle = await store.save({ title: { a: 1 }, original: 'x' })
  assert.equal(typeof objectTitle.title, 'string')
  const empty = await store.save({ title: null, original: null })
  assert.equal(empty.title, 'Untitled prompt')
  assert.equal((await store.list()).length, 4)
})

test('a hand-edited library.json with malformed entries is read without crashing', async () => {
  await store.clear()
  const good = { id: 'good', title: 'Widgets plan', original: 'plan the widgets', fixed: 'x', tags: ['a'] }
  const entries = [
    null,
    'junk',
    42,
    ['not', 'an', 'entry'],
    { title: 'no id, dropped' },
    { id: 'numeric', title: 7, original: null, fixed: 9, tags: [3, null, 'widgets'] },
    good,
  ]
  fs.writeFileSync(FILE, JSON.stringify({ version: 1, entries }), 'utf8')

  const all = await store.list()
  assert.equal(all.length, 2)
  assert.ok(all.every((e) => e && typeof e.id === 'string'), 'no null or id-less entries reach the client')

  const searched = await store.list({ query: 'widgets' })
  assert.deepEqual(
    searched.map((e) => e.id),
    ['numeric', 'good']
  )
  const numeric = await store.get('numeric')
  assert.equal(numeric.title, '7')
  assert.equal(numeric.original, '')
  assert.equal(numeric.fixed, '9')
  assert.deepEqual(numeric.tags, ['3', 'widgets'])

  // Mutations on the same file keep working and rewrite it well-formed.
  assert.deepEqual(await store.remove('numeric'), { removed: true })
  const updated = await store.save({ id: 'good', favorite: true })
  assert.equal(updated.favorite, true)
  assert.equal(updated.title, 'Widgets plan')
  const onDisk = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  assert.equal(onDisk.entries.length, 1)
})

// --- few-shot lookup ---------------------------------------------------------

const improved = (original, extra = {}) => ({ original, fixed: `${original} — fixed`, scoreBefore: 50, scoreAfter: 80, ...extra })

test('similar() ranks by shared vocabulary and prefers the same intent', async () => {
  await store.clear()
  const close = await store.save(improved('write a blog post about our new pricing page'))
  const closer = await store.save(improved('write a blog post about our new feature launch'))
  const far = await store.save(improved('refactor the parse function in utils.py'))
  // Shares five words with the prompt where `close` shares six: near enough for the intent bonus to decide it.
  const sameIntent = await store.save(improved('write a blog post about our pricing', { options: { intent: 'writing' } }))

  const prompt = 'write a blog post about our new feature'
  const top = await store.similar(prompt)
  assert.deepEqual(
    top.map((e) => e.id),
    [closer.id, close.id],
    'default limit is two, most similar first'
  )
  assert.ok(!(await store.similar(prompt, { limit: 10 })).some((e) => e.id === far.id), 'nothing in common means not similar')
  assert.equal((await store.similar(prompt, { limit: 1 })).length, 1)
  assert.deepEqual(await store.similar('', { limit: 5 }), [], 'an empty prompt matches nothing')
  assert.deepEqual(await store.similar('zzz qqq', { limit: 5 }), [])

  // Same intent breaks a near-tie, but cannot outrank a clearly closer prompt.
  const writing = await store.similar(prompt, { intent: 'writing' })
  assert.equal(writing[0].id, closer.id)
  assert.equal(writing[1].id, sameIntent.id, 'the same-intent entry edges out the one that shares a couple more words')
  assert.equal((await store.similar(prompt, { intent: 'code' }))[1].id, close.id)
})

test('similar() never offers the prompt itself, and only rewrites that scored higher', async () => {
  await store.clear()
  const prompt = 'write a blog post about our new feature'
  await store.save(improved(prompt))
  await store.save(improved(`  ${prompt}\n`, { title: 'differs by whitespace only' }))
  await store.save({ original: 'write a blog post about our new pricing', fixed: 'x', scoreBefore: 70, scoreAfter: 70 })
  await store.save({ original: 'write a blog post about our new onboarding', fixed: 'x', scoreBefore: 70, scoreAfter: 60 })
  await store.save({ original: 'write a blog post about our new docs', fixed: 'x', scoreBefore: null, scoreAfter: 90 })
  await store.save({ original: 'write a blog post about our new roadmap', fixed: '', scoreBefore: 40, scoreAfter: 90 })
  assert.deepEqual(await store.similar(prompt, { limit: 10 }), [])

  const gained = await store.save({ original: 'write a blog post about our new team page', fixed: 'Better.', scoreBefore: '40', scoreAfter: '90' })
  assert.deepEqual(
    (await store.similar(prompt, { limit: 10 })).map((e) => e.id),
    [gained.id],
    'string scores from a hand-edited file still count'
  )
})

test('similar() tolerates a malformed library.json the way list() does', async () => {
  await store.clear()
  const entries = [
    null,
    'junk',
    { title: 'no id' },
    { id: 'shape', original: 12, fixed: null, scoreBefore: 'x', scoreAfter: {} },
    { id: 'opts', original: 'write a blog post about pricing', fixed: 'ok', scoreBefore: 1, scoreAfter: 2, options: 'writing' },
    { id: 'good', original: 'write a blog post about our new pricing', fixed: 'ok', scoreBefore: 1, scoreAfter: 2, options: { intent: 'writing' } },
  ]
  fs.writeFileSync(FILE, JSON.stringify({ version: 1, entries }), 'utf8')
  const found = await store.similar('write a blog post about our new feature', { intent: 'writing', limit: 5 })
  assert.deepEqual(
    found.map((e) => e.id),
    ['good', 'opts']
  )
})

// --- import ------------------------------------------------------------------

test('importEntries() skips known ids and malformed entries, and respects the cap', async () => {
  await store.clear()
  const mine = await store.save({ original: 'mine', fixed: 'Mine.' })
  const result = await store.importEntries([
    { ...mine, fixed: 'overwritten?' },
    { id: 'new-1', original: 'one', fixed: 'One.', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-02T00:00:00.000Z', tags: ['x'] },
    { id: 'new-2', original: 'two', fixed: 'Two.', createdAt: '2021-01-01T00:00:00.000Z' },
    { id: 'new-2', original: 'duplicate within the file', fixed: 'x' },
    { id: '', original: 'blank id', fixed: 'x' },
    { id: 'no-texts' },
    { id: 'numeric-texts', original: 1, fixed: 2 },
    null,
    'junk',
  ])
  assert.deepEqual(result, { imported: 2, skipped: 7, total: 3 })
  const all = await store.list()
  assert.deepEqual(
    all.map((e) => e.id),
    [mine.id, 'new-2', 'new-1'],
    'newest first by createdAt, an old import lands at the bottom'
  )
  assert.equal((await store.get(mine.id)).fixed, 'Mine.')
  const one = await store.get('new-1')
  assert.equal(one.createdAt, '2020-01-01T00:00:00.000Z')
  assert.equal(one.updatedAt, '2020-01-02T00:00:00.000Z')
  assert.equal(one.title, 'one')
  assert.deepEqual(one.tags, ['x'])
  assert.equal(one.favorite, false)
  assert.deepEqual(await store.importEntries('not an array'), { imported: 0, skipped: 0, total: 3 })

  // 499 on disk, three offered: one fits, then the cap holds.
  const full = Array.from({ length: 499 }, (_, i) => ({ id: `bulk-${i}`, original: `b${i}`, fixed: 'x' }))
  fs.writeFileSync(FILE, JSON.stringify({ version: 1, entries: full }), 'utf8')
  const capped = await store.importEntries([
    { id: 'fits', original: 'a', fixed: 'b' },
    { id: 'over-1', original: 'a', fixed: 'b' },
    { id: 'over-2', original: 'a', fixed: 'b' },
  ])
  assert.deepEqual(capped, { imported: 1, skipped: 2, total: 500 })
  assert.equal((await store.list()).length, 500)
  assert.ok((await store.get('fits')).createdAt, 'a missing createdAt is filled in')
})
