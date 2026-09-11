import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256File, writeSums, checkSums } from './release-checksums.js'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'release-checksums.js')
// sha256("abc"), the FIPS 180-2 test vector.
const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
const run = (args, cwd) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' })

/** A fake release folder: two artifacts plus one builder file that must be ignored. */
function releaseDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-sums-'))
  fs.writeFileSync(path.join(dir, 'PromptFixer-0.1.0-win-x64.exe'), 'abc')
  fs.writeFileSync(path.join(dir, 'PromptFixer-0.1.0-win-x64.exe.blockmap'), 'abc')
  fs.writeFileSync(path.join(dir, 'builder-debug.yml'), 'not an artifact')
  return dir
}

test('sha256File matches the FIPS test vector', async () => {
  const dir = releaseDir()
  try {
    assert.equal(await sha256File(path.join(dir, 'PromptFixer-0.1.0-win-x64.exe')), ABC)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('writes sha256sum-format lines for artifacts only, sorted, lowercase, two spaces', async () => {
  const dir = releaseDir()
  try {
    const text = await writeSums(dir)
    assert.equal(text, `${ABC}  PromptFixer-0.1.0-win-x64.exe\n${ABC}  PromptFixer-0.1.0-win-x64.exe.blockmap\n`)
    assert.equal(fs.readFileSync(path.join(dir, 'SHA256SUMS.txt'), 'utf8'), text)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('--check passes on intact files and exits 1 on a modified one', async () => {
  const dir = releaseDir()
  try {
    assert.equal(run(['--dir', dir], dir).status, 0)
    assert.equal(run(['--check', '--dir', dir], dir).status, 0)
    fs.appendFileSync(path.join(dir, 'PromptFixer-0.1.0-win-x64.exe'), 'x')
    const bad = run(['--check', '--dir', dir], dir)
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /PromptFixer-0\.1\.0-win-x64\.exe: FAILED/)
    assert.deepEqual(await checkSums(dir), ['PromptFixer-0.1.0-win-x64.exe: FAILED'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
