import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'setup-model.js')

/**
 * Run the setup script from `cwd` and resolve with its output once the banner
 * (up to the `Location :` line) is printed; the child is killed at that point,
 * before it can start a download.
 */
function banner(cwd, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    // Strip the keys under test from the inherited env so only the temp .env speaks.
    const clean = { ...process.env }
    delete clean.PROMPTFIXER_MODEL
    delete clean.PROMPTFIXER_MODEL_DIR
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd, env: { ...clean, ...env } })
    let out = ''
    let killed = false
    child.stdout.on('data', (chunk) => {
      out += chunk
      if (!killed && /Location\s*:.*\n/.test(out)) {
        killed = true
        child.kill()
      }
    })
    child.stderr.on('data', (chunk) => {
      out += chunk
    })
    child.on('error', reject)
    // Resolve only once the child is gone: its cwd is the temp dir the caller deletes.
    child.on('exit', (code) => {
      if (killed) resolve(out)
      else reject(new Error(`exited ${code} before printing the banner:\n${out}`))
    })
  })
}

test('npm run setup honours PROMPTFIXER_MODEL_DIR and PROMPTFIXER_MODEL from .env', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-setup-'))
  const modelDir = path.join(dir, 'm')
  fs.writeFileSync(path.join(dir, '.env'), `PROMPTFIXER_MODEL_DIR=${modelDir}\nPROMPTFIXER_MODEL=lite\n`)
  try {
    const out = await banner(dir)
    const location = out.match(/Location\s*:\s*(.+)/)?.[1].trim()
    assert.ok(location, out)
    assert.ok(location.startsWith(modelDir), `expected ${location} to start with ${modelDir}`)
    assert.match(out, /Tier\s*:\s*lite \(from PROMPTFIXER_MODEL\)/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an explicit CLI tier still wins over PROMPTFIXER_MODEL', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-setup-'))
  fs.writeFileSync(path.join(dir, '.env'), `PROMPTFIXER_MODEL=lite\n`)
  try {
    const out = await banner(dir, ['quality'])
    assert.match(out, /Tier\s*:\s*quality —/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
