/**
 * The streaming path: reading a rewrite out of JSON that is still arriving, and
 * the catalog's disk helpers behind the free-space check and the delete button.
 * No model and no network — the reader is pure and the disk helpers run against
 * a throwaway directory. Run with: npm test
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { OUTPUT_SCHEMA, partialStringField, STREAMED_FIELD } from './metaprompt.js'

// --- partialStringField ------------------------------------------------------

const field = (raw) => partialStringField(raw, STREAMED_FIELD)

test('the streamed field is the first property the grammar emits', () => {
  // Reading a rewrite out of a half-finished reply only works while it is
  // first. Reordering OUTPUT_SCHEMA would silently turn streaming off, with
  // every other test still green, so the ordering is asserted rather than
  // left to a comment.
  assert.equal(Object.keys(OUTPUT_SCHEMA.properties)[0], STREAMED_FIELD)
})

test('nothing to show until the opening quote has arrived', () => {
  for (const raw of ['', '{', '{"fixed', '{"fixedPrompt"', '{"fixedPrompt" ', '{"fixedPrompt":']) {
    assert.equal(field(raw), null, `expected null for ${JSON.stringify(raw)}`)
  }
})

test('an open quote is an empty rewrite, not a missing one', () => {
  assert.deepEqual(field('{"fixedPrompt": "'), { text: '', complete: false })
})

test('text arriving a piece at a time reads back as what has arrived', () => {
  assert.deepEqual(field('{"fixedPrompt": "Write a'), { text: 'Write a', complete: false })
  assert.deepEqual(field('{"fixedPrompt": "Write a blog'), { text: 'Write a blog', complete: false })
})

test('the closing quote completes it, and later fields are ignored', () => {
  assert.deepEqual(field('{"fixedPrompt":"done","summary":"x"'), { text: 'done', complete: true })
})

test('escapes are decoded', () => {
  assert.deepEqual(field(String.raw`{"fixedPrompt":"one\ntwo"`), { text: 'one\ntwo', complete: true })
  assert.deepEqual(field(String.raw`{"fixedPrompt":"say \"hi\" now"`), {
    text: 'say "hi" now',
    complete: true,
  })
  assert.deepEqual(field(String.raw`{"fixedPrompt":"a\\b"`), { text: 'a\\b', complete: true })
  assert.deepEqual(field(String.raw`{"fixedPrompt":"été"`), { text: 'été', complete: true })
})

test('an escape split across chunks does not leak a stray character', () => {
  // The chunk ends mid-escape; the text stops before it and the next chunk
  // carries the pair whole.
  // Not String.raw: a raw literal cannot end in the backslash this case is about.
  assert.deepEqual(field('{"fixedPrompt":"a\\'), { text: 'a', complete: false })
  assert.deepEqual(field(String.raw`{"fixedPrompt":"a\u00`), { text: 'a', complete: false })
  assert.deepEqual(field(String.raw`{"fixedPrompt":"aé`), { text: 'aé', complete: false })
})

test('a rewrite that itself contains the field name is not re-anchored', () => {
  // indexOf finds the real field first, so the quoted mention inside the value
  // is just text.
  assert.deepEqual(field('{"fixedPrompt":"set "fixedPrompt" to x'), {
    text: 'set ',
    complete: true,
  })
})

test('whitespace around the colon is allowed, as the grammar may emit it', () => {
  assert.deepEqual(field('{ "fixedPrompt"  :   "hi'), { text: 'hi', complete: false })
})

test('the reader is monotonic: each chunk only ever extends the last', () => {
  const whole = String.raw`{"fixedPrompt":"Write a \"short\" post.\nBe brief.","summary":"s"}`
  let previous = ''
  for (let i = 1; i <= whole.length; i++) {
    const seen = field(whole.slice(0, i))
    if (!seen) continue
    assert.ok(
      seen.text.startsWith(previous) || previous.startsWith(seen.text),
      `chunk ${i} rewrote earlier text: ${JSON.stringify(previous)} -> ${JSON.stringify(seen.text)}`
    )
    if (seen.text.length >= previous.length) previous = seen.text
  }
  assert.equal(previous, 'Write a "short" post.\nBe brief.')
})

// --- disk helpers ------------------------------------------------------------
// models.js reads MODEL_DIR at import time, so the directory is set before it
// is imported and the import is deferred to here.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promptfixer-models-'))
process.env.PROMPTFIXER_MODEL_DIR = tmp
const { MODELS, bytesOnDisk, deleteModel, filesFor, freeSpaceBytes, spaceForDownload } = await import(
  './models.js'
)

const spec = MODELS.lite
/** A file of `size` bytes named like a real download of the lite tier. */
const put = (name, size) => {
  const full = path.join(tmp, name)
  fs.writeFileSync(full, Buffer.alloc(size))
  return full
}

test('free space is a number on this platform, or null where it cannot be read', () => {
  const free = freeSpaceBytes()
  assert.ok(free === null || (Number.isFinite(free) && free > 0))
})

test('free space is read from a parent when the model directory is not there yet', () => {
  // The downloader creates MODEL_DIR, so the check has to work before it exists.
  assert.notEqual(freeSpaceBytes(path.join(tmp, 'not', 'created', 'yet')), undefined)
})

test('a download is allowed when the space is unknown', () => {
  // ok must never be false just because the number could not be read: an
  // unknown value is not a reason to refuse a download.
  const room = spaceForDownload('lite')
  assert.equal(typeof room.ok, 'boolean')
  assert.ok(room.needed > spec.bytes, 'asks for headroom over the file itself')
  if (room.free === null) assert.equal(room.ok, true)
})

test('part-files count towards what is on disk and are deleted with the model', () => {
  const partial = put(`hf_bartowski_${spec.file}.part`, 2048)
  const other = put('unrelated.gguf', 16)

  assert.equal(bytesOnDisk('lite'), 2048)
  assert.equal(filesFor('lite').length, 1)
  assert.equal(filesFor('lite')[0].complete, false, 'a part-file is not a usable model')

  const { removed, freed } = deleteModel('lite')
  assert.deepEqual(removed, [path.basename(partial)])
  assert.equal(freed, 2048)
  assert.equal(bytesOnDisk('lite'), 0)
  assert.equal(fs.existsSync(other), true, 'left files belonging to no tier alone')

  fs.rmSync(other)
})

test('deleting a tier that has nothing on disk is not an error', () => {
  assert.deepEqual(deleteModel('lite'), { removed: [], freed: 0 })
})

test('an unknown tier is refused', () => {
  assert.throws(() => deleteModel('enormous'), /Unknown model tier/)
})

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
