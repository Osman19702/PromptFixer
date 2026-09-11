/**
 * Group K — The desktop application.
 * Scenarios: acceptance/features/K-desktop.feature. Run: npm run test:acceptance
 *
 * K2 and K3 launch the real Electron app from source through Playwright's
 * Electron driver (a window opens briefly). K1 needs the installer on a clean
 * machine and K4 needs the packaged/unpackaged configuration matrix; both stay
 * nightly. K5 and K6 are server behaviours the desktop story depends on.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { _electron as electron } from 'playwright'

import { startApp } from './support/app.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const NIGHTLY = 'desktop tier, nightly: needs the packaged installer on a clean machine'

/** Launch the app from source with an empty model directory and no keys. */
async function launchDesktop() {
  const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptfixer-acc-electron-'))
  // Some tool shells export ELECTRON_RUN_AS_NODE=1, which makes Electron start
  // as plain Node and reject the debugging flags Playwright needs.
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const eapp = await electron.launch({
    args: [ROOT],
    cwd: ROOT,
    env: {
      ...env,
      PROMPTFIXER_PRELOAD: '0',
      PROMPTFIXER_MODEL_DIR: modelDir,
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      OPENROUTER_API_KEY: '',
      GOOGLE_API_KEY: '',
      COMPATIBLE_BASE_URL: '',
    },
  })
  const win = await eapp.firstWindow()
  await win.locator('textarea.editor').waitFor({ timeout: 20000 })
  return {
    eapp,
    win,
    origin: new URL(win.url()).origin,
    async close() {
      await eapp.close().catch(() => {})
      fs.rmSync(modelDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    },
  }
}

test('K1 — Install, run, uninstall, reinstall', { todo: NIGHTLY }, () => {})

test('K2 — The window opens our interface and nothing else', async () => {
  const d = await launchDesktop()
  try {
    // A file or data URL dropped on the page is what Chromium would otherwise navigate to.
    for (const url of ['file:///C:/Windows/win.ini', 'data:text/html,<h1>not ours</h1>']) {
      await d.win.evaluate((u) => {
        window.location.href = u
      }, url)
      await d.win.waitForTimeout(600)
      assert.ok(d.win.url().startsWith(d.origin), `${url} was blocked; still at ${d.win.url()}`)
      assert.equal(await d.win.locator('textarea.editor').count(), 1, 'our interface is still there')
    }
    // window.open never yields a second window.
    await d.win.evaluate(() => window.open('file:///C:/Windows/win.ini'))
    await d.win.waitForTimeout(600)
    assert.equal(d.eapp.windows().length, 1, 'no second window')
    // http(s) links go to the system browser — asserted in electron/handlers.test.js
    // rather than here, where it would open the developer's real browser.
  } finally {
    await d.close()
  }
})

test('K3 — Quitting is deterministic', async () => {
  const d = await launchDesktop()
  const started = Date.now()
  const closed = d.eapp.waitForEvent('close', { timeout: 10000 })
  await d.win.close()
  await closed
  const elapsed = Date.now() - started
  assert.ok(elapsed < 6000, `the app quit in ${elapsed} ms (unload is bounded at 2 s)`)
  await d.close()
})

test('K4 — Configuration is read from where the documentation says', { todo: 'desktop tier, nightly: packaged vs source .env matrix (logic covered by electron/env.test.js)' }, () => {})

test('K5 — The app finds a free port and its interface finds the app', async () => {
  const [one, two] = await Promise.all([startApp(), startApp()])
  try {
    assert.notEqual(one.base, two.base, 'two copies got two ports')
    assert.equal((await one.get('/api/health')).body.ok, true)
    assert.equal((await two.get('/api/health')).body.ok, true)
  } finally {
    await Promise.all([one.stop(), two.stop()])
  }
})

test('K6 — An unknown API route is a not-found, not the application shell', async () => {
  const app = await startApp()
  try {
    const missing = await app.raw('GET', '/api/definitely-not-a-route')
    assert.equal(missing.status, 404)
    assert.doesNotMatch(missing.text, /<html|<div id="root"/i, 'not the interface HTML, nor any HTML')
    assert.match(missing.body.error, /definitely-not-a-route/, 'a JSON error naming the route, like every other API error')

    const shell = await app.raw('GET', '/some/client/route')
    assert.ok(shell.status === 200 || shell.status === 404)
    if (shell.status === 200) assert.match(shell.text, /<html/i, 'a non-API path serves the interface')
  } finally {
    await app.stop()
  }
})
