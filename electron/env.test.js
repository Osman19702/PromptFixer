import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadDesktopEnv } from './env.js'

const KEYS = ['DEFAULT_PROVIDER', 'PROMPTFIXER_PRELOAD', 'PROMPTFIXER_ENV_FILE', 'COMPATIBLE_BASE_URL']

function scratch(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-env-'))
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), body)
  }
  return dir
}

function withCleanEnv(fn) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  for (const k of KEYS) delete process.env[k]
  try {
    return fn()
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

test('packaged: reads .env from the user-data dir and lets it override the desktop defaults', () => {
  const userData = scratch({
    '.env': 'DEFAULT_PROVIDER=anthropic\nPROMPTFIXER_PRELOAD=0\nCOMPATIBLE_BASE_URL=http://127.0.0.1:9911\n',
  })
  withCleanEnv(() => {
    const file = loadDesktopEnv({ userDataDir: userData, packaged: true, cwd: scratch({}) })
    assert.equal(file, path.join(userData, '.env'))
    assert.equal(process.env.PROMPTFIXER_ENV_FILE, file)
    assert.equal(process.env.DEFAULT_PROVIDER, 'anthropic')
    assert.equal(process.env.PROMPTFIXER_PRELOAD, '0')
    assert.equal(process.env.COMPATIBLE_BASE_URL, 'http://127.0.0.1:9911')
  })
})

test('defaults apply only when .env is silent', () => {
  const userData = scratch({ '.env': 'COMPATIBLE_BASE_URL=http://127.0.0.1:9911\n' })
  withCleanEnv(() => {
    loadDesktopEnv({ userDataDir: userData, packaged: true, cwd: scratch({}) })
    assert.equal(process.env.DEFAULT_PROVIDER, 'local')
    assert.equal(process.env.PROMPTFIXER_PRELOAD, '1')
  })
})

test('missing .env is not an error and still yields the defaults', () => {
  withCleanEnv(() => {
    const file = loadDesktopEnv({ userDataDir: scratch({}), packaged: true, cwd: scratch({}) })
    assert.ok(!fs.existsSync(file))
    assert.equal(process.env.DEFAULT_PROVIDER, 'local')
    assert.equal(process.env.PROMPTFIXER_PRELOAD, '1')
  })
})

test('dev: the project .env wins over user-data, and a shell variable wins over both', () => {
  const project = scratch({ '.env': 'DEFAULT_PROVIDER=openai\n' })
  const userData = scratch({ '.env': 'DEFAULT_PROVIDER=anthropic\nPROMPTFIXER_PRELOAD=0\n' })
  withCleanEnv(() => {
    process.env.PROMPTFIXER_PRELOAD = '1'
    loadDesktopEnv({ userDataDir: userData, packaged: false, cwd: project })
    assert.equal(process.env.DEFAULT_PROVIDER, 'openai')
    assert.equal(process.env.PROMPTFIXER_PRELOAD, '1')
  })
})

test('packaged: the cwd .env is ignored', () => {
  const project = scratch({ '.env': 'DEFAULT_PROVIDER=openai\n' })
  withCleanEnv(() => {
    loadDesktopEnv({ userDataDir: scratch({}), packaged: true, cwd: project })
    assert.equal(process.env.DEFAULT_PROVIDER, 'local')
  })
})
