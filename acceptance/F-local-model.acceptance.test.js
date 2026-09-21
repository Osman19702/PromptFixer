/**
 * Group F — The local model.
 * Scenarios: acceptance/features/F-local-model.feature. Run: npm run test:acceptance
 *
 * Only the scenarios that need no model file run here; the rest are nightly
 * on the GPU machine and are listed as todo so the gap is visible.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { startApp } from './support/app.js'
import { closeBrowser, launchBrowser, openApp, runFix, typePrompt, ui } from './support/browser.js'
import { BLOG_PROMPT } from './support/fixtures.js'
import { runWatched } from './support/netwatch.mjs'
import { startStub } from './support/stub-provider.js'

const NIGHTLY = 'nightly on the GPU machine: needs a model file'

let app
before(async () => {
  app = await startApp()
})
after(() => app.stop())

test('F1 — A first-run user with no model is told exactly what to do', async () => {
  const status = (await app.get('/api/local/status')).body
  assert.equal(status.phase, 'missing')
  assert.equal(status.downloaded, false)
  assert.ok(status.model.label, 'the model is named')
  assert.ok(status.model.bytes > 500_000_000, 'and its size is known')
  assert.equal(status.catalog.length, 3, 'every tier is listed')
  for (const tier of status.catalog) assert.equal(tier.downloaded, false)

  const fix = await app.post('/api/fix', { prompt: BLOG_PROMPT, provider: 'local' })
  assert.ok(fix.status >= 400, 'a fix cannot succeed')
  assert.equal(fix.body.code, 'MODEL_MISSING')
  assert.match(fix.body.error, /download|not downloaded|missing/i, 'and the reason is the model, not a generic failure')

  const lint = await app.analyze(BLOG_PROMPT)
  assert.equal(lint.status, 200, 'linting works regardless')
})

test('F2 — The download is visible, resumable and cancellable', { todo: NIGHTLY }, () => {})
test('F3 — A download that produced no usable file says so', { todo: NIGHTLY }, () => {})

test('F4 — The machine picks a sensible model on its own', async () => {
  const chosen = await startApp({ env: { PROMPTFIXER_MODEL: 'lite' } })
  try {
    const status = (await chosen.get('/api/local/status')).body
    assert.equal(status.tier, 'lite', 'an explicit choice always wins')
  } finally {
    await chosen.stop()
  }
  const auto = (await app.get('/api/local/status')).body
  assert.ok(['lite', 'default'].includes(auto.tier), `the automatic pick is a real tier: ${auto.tier}`)
})

test('F5 — Switching models is safe at any moment', async () => {
  const bad = await app.post('/api/local/select', { tier: 'enormous' })
  assert.ok(bad.status >= 400)
  assert.equal(bad.body.code, 'BAD_TIER')
  assert.match(bad.body.error, /enormous/)

  const ok = await app.post('/api/local/select', { tier: 'quality' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.tier, 'quality')
  assert.equal(ok.body.phase, 'missing', 'the new tier is not on disk either')
  await app.post('/api/local/select', { tier: 'default' })
})

test('F6 — Loading is never confused about which model it is loading', { todo: NIGHTLY }, () => {})
test('F7 — The GPU is used when it exists and its absence is not a failure', { todo: NIGHTLY }, () => {})
test('F8 — A prompt too long for the model is refused with advice, not truncated', { todo: NIGHTLY }, () => {})
test('F9 — The result is always structurally valid', { todo: NIGHTLY }, () => {})
test('F10 — Quitting releases the model', { todo: 'desktop tier, nightly' }, () => {})
/**
 * F11 is the app's headline claim, so it is asserted rather than described.
 *
 * A server started with `netwatch: true` runs under acceptance/support/netwatch.mjs,
 * which hooks the three ways JavaScript in a Node process reaches the network —
 * outbound TCP (and therefore TLS, http, https and fetch), UDP, and name
 * resolution — and appends every destination that is not this machine to a log.
 * A full session then has to leave that log empty.
 *
 * Two things this deliberately does NOT claim, both checked by hand instead:
 *   - a native addon opening a socket from C++ with no JavaScript involved is
 *     invisible to any hook installed from JavaScript;
 *   - downloading the model plainly does go to the network. That is the one
 *     documented exception and this session never triggers it, which is why an
 *     empty log here is meaningful rather than tautological.
 */
test('F11 — Nothing leaves the machine', async () => {
  // The stub stands in for the model so a real fix can run end to end. It
  // listens on this machine, so reaching it is not leaving — which is exactly
  // the distinction the watcher has to draw.
  const stub = await startStub()
  const watched = await startApp({ stub, netwatch: true })
  const browser = await launchBrowser()
  let session

  try {
    // --- the watcher is not asleep ------------------------------------------
    // A test that cannot fail proves nothing, so make the watcher catch one
    // first — through runWatched, which installs it exactly as the harness
    // above does, so this proves the path actually under test. example.invalid
    // is reserved by RFC 6761 and never resolves, so the attempt is recorded
    // and no packet reaches the wire.
    const caught = await runWatched(
      "import net from 'node:net'; net.connect(443, 'telemetry.example.invalid').on('error', () => {})"
    )
    assert.ok(
      caught.some((a) => a.host === 'telemetry.example.invalid'),
      'the watcher must catch a deliberate call off the machine, or an empty log below means nothing'
    )

    // --- a full session ------------------------------------------------------
    // Lint, fix, save, list, export, import — plus the routes the interface
    // touches on the way (config, examples, local status).
    assert.equal((await watched.get('/api/config')).status, 200)
    assert.equal((await watched.get('/api/examples')).status, 200)
    assert.equal((await watched.get('/api/local/status')).status, 200)

    const lint = await watched.analyze(BLOG_PROMPT)
    assert.equal(lint.status, 200, 'lint')

    const fixed = await watched.fix(BLOG_PROMPT)
    assert.equal(fixed.status, 200, 'fix')

    const saved = await watched.post('/api/library', {
      original: BLOG_PROMPT,
      fixed: fixed.body.fixedPrompt,
      summary: fixed.body.summary,
      scoreBefore: fixed.body.before,
      scoreAfter: fixed.body.after,
    })
    assert.equal(saved.status, 201, 'save')
    assert.equal((await watched.get('/api/library')).status, 200, 'list')

    const exported = await watched.get('/api/library/export')
    assert.equal(exported.status, 200, 'export')
    assert.equal(
      (await watched.post('/api/library/import', { entries: exported.body.entries })).status,
      200,
      'import'
    )

    // A fix on the local provider with no model is the other path a first-run
    // user takes; it must not reach for a download on its own either.
    const noModel = await watched.post('/api/fix', { prompt: BLOG_PROMPT, provider: 'local' })
    assert.equal(noModel.body.code, 'MODEL_MISSING')

    // --- and the same session through the real interface ---------------------
    // The prompt is typed into a browser, so the page is the other place it
    // could leave from: a font, an icon, a source map, an analytics beacon.
    //
    // The listener is handed to openApp rather than attached afterwards. By the
    // time openApp returns it has already navigated, so a listener attached
    // here would miss the document, the script, the stylesheet and every font
    // or icon they pull in — the whole load, which is where a CDN reference
    // would actually show up.
    const offOrigin = []
    const own = new URL(watched.base).origin
    session = await openApp(watched, {
      onRequest: (request) => {
        const url = request.url()
        // data: and blob: never leave the process; about:blank is the new tab.
        if (/^(data|blob|about|chrome-extension):/i.test(url)) return
        if (new URL(url).origin !== own) offOrigin.push(`${request.method()} ${url}`)
      },
    })

    await typePrompt(session.page, BLOG_PROMPT)
    await runFix(session.page)
    assert.equal(await ui.output(session.page).count(), 1, 'the browser session really ran a fix')

    assert.deepEqual(
      await session.page.evaluate(() => navigator.serviceWorker?.getRegistrations?.().then((r) => r.length) ?? 0),
      0,
      'no service worker, so no request can be made from outside the page'
    )
    // Unload-time beacons only fire when the page actually goes away, and
    // closing the context would discard them unsent.
    await session.page.goto('about:blank')
    assert.deepEqual(offOrigin, [], 'the page asked for nothing beyond its own origin')

    // --- the claim -----------------------------------------------------------
    // Read after the server has stopped, not while it is running: a deferred
    // timer or a queued flush would otherwise never be seen, and stop() deletes
    // the log straight afterwards.
    const recorded = await watched.drain()
    const show = (list) =>
      list.map((a) => `  ${a.kind} ${a.host}:${a.port}\n    ${a.stack}`).join('\n')

    // A proxy on loopback would make every destination look like this machine,
    // so a run in that environment cannot be evidence of anything.
    const proxies = recorded.filter((a) => a.kind === 'proxy')
    assert.deepEqual(
      proxies,
      [],
      `a proxy variable was set, so a clean result here would mean nothing:\n${show(proxies)}`
    )

    // A child process is the one hole the watcher cannot see through, because
    // --import is not inherited across a spawn. Recording the spawn itself
    // turns "we saw nothing" into "we saw nothing, and nothing was delegated
    // to somewhere we could not have seen".
    const spawned = recorded.filter((a) => a.kind === 'spawn')
    assert.deepEqual(
      spawned,
      [],
      `the session started a child process, whose traffic this cannot see:\n${show(spawned)}`
    )

    const offMachine = recorded.filter((a) => a.kind !== 'spawn' && a.kind !== 'proxy')
    assert.deepEqual(offMachine, [], `the server reached off this machine:\n${show(offMachine)}`)
  } finally {
    await session?.close().catch(() => {})
    await closeBrowser().catch(() => {})
    await watched.stop().catch(() => {})
    await stub.close().catch(() => {})
  }
})
