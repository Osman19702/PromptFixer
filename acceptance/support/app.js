/**
 * Boots the real PromptFixer server as a child process, the way a user's
 * machine would run it, with a private data directory, an empty model
 * directory and an OS-assigned port so runs never collide.
 *
 * Returns a small HTTP client. Every response is checked for the canary API
 * key: if it ever appears in a body, a key has left the server, and the
 * scenario that noticed fails regardless of what it was testing.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(__dirname, '..', '..', 'server', 'index.js')

export const CANARY_KEY = 'canary-compatible-key-7f3a'

/**
 * @param stub   The stub provider from stub-provider.js, or omitted for a
 *               server with no provider configured at all.
 * @param env    Overrides for the server's environment.
 */
export async function startApp({ stub, env = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptfixer-acc-data-'))
  const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptfixer-acc-models-'))

  const childEnv = {
    ...process.env,
    PORT: '0',
    // The developer's .env and shell must not steer the server under test.
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    OPENROUTER_API_KEY: '',
    GOOGLE_API_KEY: '',
    OLLAMA_BASE_URL: '',
    COMPATIBLE_BASE_URL: '',
    COMPATIBLE_API_KEY: '',
    COMPATIBLE_LABEL: '',
    DEFAULT_PROVIDER: '',
    DEFAULT_MODEL: '',
    PROMPTFIXER_MODEL: '',
    PROMPTFIXER_PRELOAD: '0',
    PROMPTFIXER_DESKTOP: '0',
    PROMPTFIXER_MODEL_DIR: modelDir,
    PROMPTFIXER_DATA_DIR: dataDir,
    ...(stub
      ? {
          COMPATIBLE_BASE_URL: stub.url,
          COMPATIBLE_LABEL: 'Stub',
          COMPATIBLE_API_KEY: CANARY_KEY,
          DEFAULT_PROVIDER: 'compatible',
        }
      : {}),
    ...env,
  }

  let child
  let base = ''
  await new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => reject(new Error('server did not start within 15s')), 15000)
    child = spawn(process.execPath, [SERVER], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (d) => {
      stdout += d
      const m = stdout.match(/PromptFixer API\s+→\s+http:\/\/localhost:(\d+)/)
      if (m) {
        base = `http://127.0.0.1:${m[1]}`
        clearTimeout(timer)
        resolve()
      }
    })
    child.stderr.on('data', (d) => {
      stderr += d
      process.stderr.write(`[server] ${d}`)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`server exited with code ${code} before it was ready.\n${stderr.slice(0, 600)}`))
    })
  })

  /** Raw fetch with the canary check; use when you need headers or a custom origin. */
  const raw = async (method, route, { body, headers = {}, signal } = {}) => {
    const res = await fetch(base + route, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
    const text = await res.text()
    assert.ok(!text.includes(CANARY_KEY), `API key leaked into ${method} ${route}: ${text.slice(0, 200)}`)
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    return { status: res.status, headers: res.headers, text, body: json }
  }

  const req = async (method, route, body, opts) => {
    const r = await raw(method, route, { body, ...opts })
    return { status: r.status, body: r.body ?? {}, headers: r.headers, text: r.text }
  }

  return {
    base,
    dataDir,
    modelDir,
    libraryFile: path.join(dataDir, 'library.json'),
    raw,
    req,
    get: (route, opts) => req('GET', route, undefined, opts),
    post: (route, body, opts) => req('POST', route, body, opts),
    del: (route) => req('DELETE', route),
    /** Convenience: POST /api/fix the way the interface does once a model is picked. */
    fix: (prompt, options = {}, extra = {}) =>
      req('POST', '/api/fix', { prompt, provider: 'compatible', model: 'stub-large', options, ...extra }),
    analyze: (prompt, options = {}) => req('POST', '/api/analyze', { prompt, options }),
    /** Empty the library between scenarios. */
    clearLibrary: () => req('DELETE', '/api/library/all'),
    async stop() {
      if (child && child.exitCode === null) {
        await new Promise((resolve) => {
          child.once('exit', resolve)
          child.kill()
        })
      }
      for (const dir of [dataDir, modelDir]) {
        // Windows can still hold a just-killed child's files open for a moment.
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    },
  }
}
