import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfigFromFile } from 'vite'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const CONFIG = path.join(ROOT, 'vite.config.ts')

/** Resolve the dev config with `cwd` as the .env directory and `PORT` (or none) in the shell. */
async function proxyTarget({ cwd, port }) {
  const savedCwd = process.cwd()
  const savedPort = process.env.PORT
  if (port === undefined) delete process.env.PORT
  else process.env.PORT = port
  process.chdir(cwd)
  try {
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, CONFIG, ROOT)
    return loaded.config.server.proxy['/api'].target
  } finally {
    process.chdir(savedCwd)
    if (savedPort === undefined) delete process.env.PORT
    else process.env.PORT = savedPort
  }
}

function scratch(envBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-vite-'))
  if (envBody !== undefined) fs.writeFileSync(path.join(dir, '.env'), envBody)
  return dir
}

test('the /api proxy follows PORT from .env', async () => {
  assert.equal(await proxyTarget({ cwd: scratch('PORT=9123\n') }), 'http://localhost:9123')
})

test('a shell PORT wins over .env, as it does for the server', async () => {
  assert.equal(await proxyTarget({ cwd: scratch('PORT=9123\n'), port: '9000' }), 'http://localhost:9000')
})

test('no PORT anywhere falls back to 8787', async () => {
  assert.equal(await proxyTarget({ cwd: scratch(), port: undefined }), 'http://localhost:8787')
  assert.equal(await proxyTarget({ cwd: scratch('PORT=\n'), port: '' }), 'http://localhost:8787')
})
