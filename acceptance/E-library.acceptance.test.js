/**
 * Group E — The prompt library.
 * Scenarios: acceptance/features/E-library.feature. Run: npm run test:acceptance
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, beforeEach, test } from 'node:test'

import { startApp } from './support/app.js'
import { libraryEntry } from './support/fixtures.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_LIBRARY = path.join(__dirname, '..', 'server', 'data', 'library.json')

let app
before(async () => {
  app = await startApp()
})
after(() => app.stop())
beforeEach(() => app.clearLibrary())

const list = async (q = '') => (await app.get(`/api/library?q=${encodeURIComponent(q)}`)).body.entries
const save = (over) => app.post('/api/library', libraryEntry(over))
const writeLibrary = (content) => fs.writeFileSync(app.libraryFile, typeof content === 'string' ? content : JSON.stringify(content))

test('E1 — Save it, find it, reopen it, delete it', async () => {
  const saved = await save()
  assert.equal(saved.status, 201)
  const entry = saved.body.entry
  assert.ok(entry.id)
  await save({ original: 'translate this contract into plain English', fixed: 'Translate…' })

  const all = await list()
  assert.equal(all.length, 2)
  const reopened = all.find((e) => e.id === entry.id)
  assert.equal(reopened.scoreBefore, 55)
  assert.equal(reopened.scoreAfter, 88)
  assert.equal(reopened.provider, 'compatible')
  assert.equal(reopened.model, 'stub-large')

  const found = await list('pricing')
  assert.deepEqual(
    found.map((e) => e.id),
    [entry.id],
    'search narrows to the match'
  )

  const removed = await app.del(`/api/library/${entry.id}`)
  assert.equal(removed.body.removed, true)
  assert.ok(!(await list()).some((e) => e.id === entry.id), 'gone immediately')
})

test('E2 — A hand-edited library file loads anyway', async () => {
  writeLibrary({
    version: 1,
    entries: [
      null,
      { id: 5, original: 'numeric id' },
      { original: 'no id at all', fixed: 'x' },
      { id: 'ok-1', original: 7, fixed: 'kept', title: 3, tags: [null, 'a'] },
    ],
  })
  const entries = await list()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, 'ok-1')
  assert.equal(entries[0].original, '7', 'a number where a string belongs is coerced')

  writeLibrary('{ this is not json')
  assert.deepEqual(await list(), [], 'unreadable file: empty library, not an error')
  const movedAside = fs.readdirSync(app.dataDir).filter((f) => f.startsWith('library.json.corrupt-'))
  assert.equal(movedAside.length, 1, 'the broken file is kept for the user')
})

test('E3 — A crash during a save cannot corrupt the library', async () => {
  let reads = 0
  let stop = false
  const reader = (async () => {
    while (!stop) {
      try {
        JSON.parse(fs.readFileSync(app.libraryFile, 'utf8'))
        reads++
      } catch (err) {
        // The file may be mid-rename; it must never be half-written.
        if (err instanceof SyntaxError) throw new Error('library.json was readable but not valid JSON')
      }
      await new Promise((r) => setTimeout(r, 2))
    }
  })()
  await Promise.all(Array.from({ length: 20 }, (_, i) => save({ original: `racing save ${i}` })))
  stop = true
  await reader
  assert.ok(reads > 0, 'the reader observed the file during the race')
  assert.equal((await list()).length, 20, 'every save is present')
  const leftovers = fs.readdirSync(app.dataDir).filter((f) => f.includes('.tmp-'))
  assert.deepEqual(leftovers, [], 'no temporary file left behind')
})

test('E4 — The library is bounded and drops the oldest first', async () => {
  const entries = Array.from({ length: 500 }, (_, i) => ({
    id: `e-${i + 1}`,
    original: `prompt ${i + 1}`,
    fixed: `fixed ${i + 1}`,
    createdAt: new Date(Date.UTC(2025, 0, 1, 0, 0, i)).toISOString(),
  }))
  const imported = await app.post('/api/library/import', { entries })
  assert.equal(imported.body.total, 500)

  const newest = (await save({ original: 'the five hundred and first' })).body.entry
  const all = await list()
  assert.equal(all.length, 500, 'the cap holds')
  assert.ok(all.some((e) => e.id === newest.id), 'the newest is present')
  assert.ok(!all.some((e) => e.id === 'e-1'), 'the oldest is gone')
})

test('E5 — A library moves between machines', async () => {
  const a = (await save({ original: 'entry A original' })).body.entry
  const b = (await save({ original: 'entry B original' })).body.entry

  const exported = await app.raw('GET', '/api/library/export')
  assert.equal(exported.status, 200)
  const today = new Date().toISOString().slice(0, 10)
  assert.match(exported.headers.get('content-disposition'), new RegExp(`promptfixer-library-${today}\\.json`))
  assert.equal(exported.body.version, 1)
  assert.equal(exported.body.entries.length, 2)

  // "Another machine": drop B, edit A locally, then import the export plus junk.
  await app.del(`/api/library/${b.id}`)
  await app.post('/api/library', { id: a.id, title: 'edited on this machine' })
  const file = { ...exported.body, entries: [...exported.body.entries, { id: '', original: 'x', fixed: 'y' }, 'junk'] }

  const first = await app.post('/api/library/import', file)
  assert.equal(first.body.imported, 1, 'B comes back')
  assert.equal(first.body.skipped, 3, 'A is known, two are malformed')
  const afterImport = await list()
  assert.equal(afterImport.find((e) => e.id === a.id).title, 'edited on this machine', 'never overwritten')
  assert.ok(afterImport.some((e) => e.id === b.id))

  const second = await app.post('/api/library/import', file)
  assert.equal(second.body.imported, 0, 'importing again adds nothing')
})

test('E6 — Importing the wrong file says so in plain words', async () => {
  await save()
  for (const wrong of [{}, { foo: 'bar' }, { entries: 'not a list' }, [1, 2, 3]]) {
    const { status, body } = await app.post('/api/library/import', wrong)
    assert.equal(status, 400, `${JSON.stringify(wrong)} should be refused`)
    assert.match(body.error, /"entries"/, 'says what shape was expected')
  }
  assert.equal((await list()).length, 1, 'the library is unchanged')
})

test('E7 — The library lives where the documentation says it lives', async () => {
  const projectStamp = fs.existsSync(PROJECT_LIBRARY) ? fs.statSync(PROJECT_LIBRARY).mtimeMs : null
  await save()
  assert.ok(fs.existsSync(app.libraryFile), `written inside the overridden data directory: ${app.libraryFile}`)
  const projectNow = fs.existsSync(PROJECT_LIBRARY) ? fs.statSync(PROJECT_LIBRARY).mtimeMs : null
  assert.equal(projectNow, projectStamp, "the project's own data folder was not touched")
})
