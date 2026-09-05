import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { installQuitHandler, willNavigateGuard } from './handlers.js'

const ORIGIN = 'http://127.0.0.1:4321'

function fakeShell() {
  const opened = []
  return { opened, openExternal: (url) => opened.push(url) }
}

function fakeEvent() {
  const event = { prevented: false }
  event.preventDefault = () => {
    event.prevented = true
  }
  return event
}

test('will-navigate: same-origin navigation is allowed', () => {
  const shell = fakeShell()
  const guard = willNavigateGuard(ORIGIN, shell)
  for (const url of [ORIGIN, `${ORIGIN}/`, `${ORIGIN}/index.html?x=1`]) {
    const event = fakeEvent()
    guard(event, url)
    assert.equal(event.prevented, false, url)
  }
  assert.deepEqual(shell.opened, [])
})

test('will-navigate: a dropped file:// URL is blocked and not opened externally', () => {
  const shell = fakeShell()
  const event = fakeEvent()
  willNavigateGuard(ORIGIN, shell)(event, 'file:///C:/Users/me/notes.txt')
  assert.equal(event.prevented, true)
  assert.deepEqual(shell.opened, [])
})

test('will-navigate: an http(s) link is blocked in-app and handed to the system browser', () => {
  const shell = fakeShell()
  const event = fakeEvent()
  willNavigateGuard(ORIGIN, shell)(event, 'https://example.com/')
  assert.equal(event.prevented, true)
  assert.deepEqual(shell.opened, ['https://example.com/'])
})

test('will-navigate: a lookalike origin does not pass the prefix check', () => {
  const shell = fakeShell()
  const event = fakeEvent()
  willNavigateGuard(ORIGIN, shell)(event, `${ORIGIN}0/evil`)
  assert.equal(event.prevented, true)
})

/** An `app` that behaves like Electron's: quit() re-emits before-quit. */
function fakeApp() {
  const app = new EventEmitter()
  app.quits = []
  app.quit = () => {
    const event = fakeEvent()
    app.emit('before-quit', event)
    app.quits.push(event.prevented ? 'prevented' : 'passed')
  }
  return app
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms))

test('before-quit: the first quit is held until unload has finished, then the second passes', async () => {
  const app = fakeApp()
  let unloaded = false
  installQuitHandler(app, async () => ({
    unload: async () => {
      await tick(50)
      unloaded = true
    },
  }))

  app.quit()
  assert.deepEqual(app.quits, ['prevented'])
  assert.equal(unloaded, false)

  await tick(120)
  assert.equal(unloaded, true)
  assert.deepEqual(app.quits, ['prevented', 'passed'])
})

test('before-quit: a failing or missing module still quits', async () => {
  const app = fakeApp()
  installQuitHandler(app, () => Promise.reject(new Error('not loaded')))
  app.quit()
  await tick(20)
  assert.deepEqual(app.quits, ['prevented', 'passed'])
})

test('before-quit: a wedged unload is bounded by the timeout', async () => {
  const app = fakeApp()
  installQuitHandler(app, async () => ({ unload: () => new Promise(() => {}) }), { timeoutMs: 30 })
  app.quit()
  await tick(10)
  assert.deepEqual(app.quits, ['prevented'])
  await tick(60)
  assert.deepEqual(app.quits, ['prevented', 'passed'])
})
