/**
 * Group N — Looking the same every time.
 * Scenarios: acceptance/features/N-appearance.feature. Run: npm run test:acceptance
 *
 * The visual check is driven the way a developer runs it: the real Elastishot
 * CLI, and the npm scripts around it, as subprocesses against the real server
 * and the scripted model; what is asserted on is the report it writes and the
 * exit code it hands back. `npm run build` must have run.
 *
 * A capture is a page load in a fresh Chromium, so this is the slowest group.
 * Every screen is approved once, up front, and the scenarios compare against
 * those pictures. Pictures and runs stay under .elastishot/runs/acceptance-*,
 * clear of a developer's own approved pictures.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, test } from 'node:test'

import { startApp } from './support/app.js'
import { BLOG_PROMPT, DISLIKED, FIX_RESPONSE, LENGTH_LINE_REVISED, LOVED, REVISED_FIX_RESPONSE, libraryEntry } from './support/fixtures.js'
import { startStub } from './support/stub-provider.js'
import { SCREENS, SIZES, changed, check, comparePictures, elementsOf, emptyFolder, named, npmRun, picture, root, seen } from './support/visual.js'

const REWRITE = '[data-testid="rewrite"]'
const BAR = '[data-testid="feedback-bar"]'
const FIX_BUTTON = /^role=button\[name="Fix prompt/

/**
 * All seven screens at both sizes, as four runs side by side — a run's fixed
 * cost is a browser launch, and this is the step every scenario waits for.
 * Each run has a server to itself: a capture begins by emptying the library.
 */
const LANES = SIZES.flatMap((size) => [SCREENS.slice(0, 4), SCREENS.slice(4)].map((screens) => screens.map((screen) => `${screen}/${size}`)))
const everyScreen = (name, { update = false } = {}) =>
  Promise.all(LANES.map((screens, i) => check(`${name}-${i + 1}`, { app: apps[i], baselines: approved, update, screens })))

let stub
let apps
let tmp
let approved
before(async () => {
  // Without a build every capture would wait out its timeout on a blank page.
  assert.ok(fs.existsSync(path.join(root, 'dist', 'index.html')), 'dist/ has no build: run "npm run build" first')
  stub = await startStub()
  apps = []
  for (let i = 0; i < LANES.length; i++) apps.push(await startApp({ stub }))
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promptfixer-acc-visual-'))
  // The Background: every screen approved, at both sizes, from nothing.
  approved = emptyFolder('pictures')
  const runs = await everyScreen('approve', { update: true })
  for (const run of runs) assert.equal(run.code, 0, `approving every screen: ${run.output}`)
})
after(async () => {
  for (const app of apps ?? []) await app.stop()
  await stub?.close()
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
beforeEach(() => stub.reset())

/** Approved pictures of the scenario's own, starting from a copy of the named ones, so approving cannot spoil the shared set. */
function picturesWith(name, ...keys) {
  const dir = emptyFolder(name)
  for (const key of keys) fs.cpSync(path.join(approved, key), path.join(dir, key), { recursive: true })
  return dir
}

const boxes = (pair) => pair.regions.flatMap((r) => [r.boxBaseline, r.boxCandidate]).filter(Boolean)
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
// A highlight's ring reaches a few pixels past the text it is on, so "inside" has that much give.
const inside = (a, b, give = 4) => a.x >= b.x - give && a.y >= b.y - give && a.x + a.w <= b.x + b.w + give && a.y + a.h <= b.y + b.h + give
const element = (elements, locator) => {
  const found = elements.find((e) => (locator instanceof RegExp ? locator.test(e.locator) : e.locator === locator))
  assert.ok(found, `the picture has no element ${locator}`)
  return found
}

/** A server the runner started is gone when nothing answers where its pictures were taken. */
const answers = (url) =>
  fetch(url, { signal: AbortSignal.timeout(3000) }).then(
    () => true,
    () => false
  )
// The harness's folders (promptfixer-acc-*) and the runner's own (promptfixer-visual-*).
const leftIn = (dir) => fs.readdirSync(dir).filter((entry) => entry.startsWith('promptfixer-'))
/** Commits that "--against" checked out and did not put away again. */
const stillCheckedOut = () => {
  const folder = path.join(root, '.elastishot', 'against')
  const known = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' })
  // git prints a worktree's path with forward slashes, on Windows too.
  const listed = known.split(/\r?\n/).filter((line) => line.startsWith('worktree ') && line.includes('/.elastishot/against/'))
  return [...(fs.existsSync(folder) ? fs.readdirSync(folder) : []), ...listed]
}

test('N1 — Every screen, captured again, matches its approved picture', async () => {
  const runs = await everyScreen('again')
  const pairs = runs.flatMap((run) => run.pairs)
  for (const run of runs) assert.equal(run.code, 0, `${run.output}\n${seen(run.pairs)}`)
  for (const size of SIZES) {
    for (const screen of SCREENS) {
      const pair = pairs.find((p) => p.target === screen && p.viewport.name === size)
      assert.ok(pair, `${screen}/${size} was captured`)
      assert.equal(pair.status, 'passed', `${screen}/${size}: ${JSON.stringify(pair.failReasons)}`)
      assert.deepEqual(pair.regions, [], `${screen}/${size} is the picture that was approved`)
    }
  }
  assert.equal(pairs.length, SCREENS.length * SIZES.length)
})

test('N2 — A rewrite that came back different is reported on the Fixed screen, by name', async () => {
  stub.byDefault({ json: REVISED_FIX_RESPONSE })
  const run = await check('revised', { app: apps[0], baselines: approved, screens: ['fixed/desktop', 'issues/desktop', 'changes/desktop'] })
  assert.equal(run.code, 1, `differences found: ${run.output}\n${seen(run.pairs)}`)
  assert.ok(stub.requests.length >= 2, 'the Fixed and Changes screens each asked the model')

  const fixed = run.pair('fixed/desktop')
  assert.equal(fixed.status, 'failed', seen(run.pairs))
  assert.deepEqual(named(fixed), [REWRITE], 'the rewrite, and only the rewrite, is named')
  // One reworded line, not everything under it: the regions fit in one line of the rewrite.
  const rewrite = element(elementsOf(picture(approved, 'fixed', 'desktop')), REWRITE).box
  const lineHeight = rewrite.h / FIX_RESPONSE.fixedPrompt.split('\n').length
  const top = Math.min(...boxes(fixed).map((b) => b.y))
  const bottom = Math.max(...boxes(fixed).map((b) => b.y + b.h))
  assert.ok(fixed.regions.length > 0 && bottom - top <= lineHeight, `"${LENGTH_LINE_REVISED}" is one line: ${JSON.stringify(boxes(fixed))}`)
  for (const box of boxes(fixed)) assert.ok(overlaps(box, rewrite), `inside the rewrite: ${JSON.stringify(box)}`)

  for (const key of ['issues/desktop', 'changes/desktop']) {
    assert.equal(run.pair(key).status, 'passed', `${key} does not show the rewrite: ${seen(run.pairs)}`)
    assert.deepEqual(run.pair(key).regions, [])
  }
})

/** How the report names a highlighted passage: by its role and what a screen reader calls it. */
const highlightOf = (verdict, passage) => new RegExp(`^role=button\\[name="Marked to ${verdict}: “${passage.replace(/[.]/g, '\\.')}”`)

test('N3 — Marks are part of the picture', async () => {
  // Side by side: the approved pictures with and without marks compared at each size, and the marked
  // screen captured again — once with its "keep" highlight no longer green, and at both sizes with
  // the paint taken off both highlights.
  const [recoloured, unpainted, ...compared] = await Promise.all([
    check('marks-recoloured', { app: apps[0], baselines: approved, screens: ['marked/desktop'], variant: 'keep-colour' }),
    check('marks-unpainted', { app: apps[1], baselines: approved, screens: SIZES.map((size) => `marked/${size}`), variant: 'marks-plain' }),
    ...SIZES.map((size) => comparePictures(`marks-${size}`, picture(approved, 'fixed', size), picture(approved, 'marked', size))),
  ])
  assert.equal(unpainted.code, 1, `highlights without their paint are a difference: ${unpainted.output}\n${seen(unpainted.pairs)}`)

  for (const [i, size] of SIZES.entries()) {
    const unmarked = picture(approved, 'fixed', size)
    const marked = picture(approved, 'marked', size)
    const run = compared[i]
    const pair = run.pair()
    assert.equal(run.code, 1, `${size}: the two pictures differ: ${run.output}`)

    const names = named(pair)
    const has = (what) => names.some((n) => (what instanceof RegExp ? what.test(n) : n === what))
    assert.ok(has(BAR), `${size}: the marking bar is named: ${names.join(' | ')}`)
    assert.ok(has('role=button[name="Clear marks"]') && has('role=button[name="Fix again with my marks"]'), `${size}: its new buttons are named: ${names.join(' | ')}`)

    // Named here, a highlight is on the page; that does not yet say it shows. In the small window
    // the bar wraps and moves the whole rewrite down, so a region lies over every passage whatever
    // its highlight looks like. What a highlight paints is what differs once the paint is taken
    // off and nothing moves: both highlights, by name, each with pixels behind it, and nothing else.
    const withMarks = elementsOf(marked)
    const plain = unpainted.pair(`marked/${size}`)
    assert.equal(plain?.status, 'failed', `${size}: ${seen(unpainted.pairs)}`)
    assert.equal(named(plain).length, 2, `${size}: the two highlights and nothing else lost their paint: ${named(plain).join(' | ')}`)
    for (const [verdict, passage] of [['keep', LOVED], ['change', DISLIKED]]) {
      assert.ok(has(highlightOf(verdict, passage)), `${size}: the passage marked "${verdict}" is named: ${names.join(' | ')}`)
      const highlight = element(withMarks, highlightOf(verdict, passage)).box
      assert.ok(pair.regions.some((r) => r.boxCandidate && overlaps(r.boxCandidate, highlight)), `${size}: and it is a reported region: ${JSON.stringify(pair.regions.map((r) => r.boxCandidate))}`)
      const painted = changed(plain).find((c) => highlightOf(verdict, passage).test(c.locator))
      assert.ok(painted, `${size}: the passage marked "${verdict}" shows as a highlight: ${named(plain).join(' | ')}`)
      assert.ok(painted.evidence.includes('pixels') && painted.regions.length > 0, `${size}: in pixels: ${JSON.stringify(painted)}`)
    }
    const highlightBoxes = [highlightOf('keep', LOVED), highlightOf('change', DISLIKED)].map((h) => element(withMarks, h).box)
    for (const box of boxes(plain)) assert.ok(highlightBoxes.some((h) => inside(box, h)), `${size}: paint outside the two highlights: ${JSON.stringify(box)}`)

    // Nowhere else. Every element the report names is the bar or part of it, the rewrite or a mark on it,
    // or the results pane around the two — never the editor pane, the tabs, the What changed line or the scores.
    const without = elementsOf(unmarked)
    const editor = element(without, '[data-testid="editor"]').box
    for (const name of names) {
      const elements = withMarks.some((e) => e.locator === name) ? withMarks : without
      const box = element(elements, name).box
      const bar = element(elements, BAR).box
      const rewrite = element(elements, REWRITE).box
      const around = inside(bar, box) && inside(rewrite, box) && box.x >= editor.x + editor.w
      assert.ok(inside(box, bar) || inside(box, rewrite) || around, `${size}: ${name} is neither the marking bar nor the rewrite`)
    }
    // And no region reaches above the bar, where the scores are.
    const scores = element(without, '[data-testid="score-panel"]').box
    for (const box of boxes(pair)) assert.ok(box.y >= scores.y + scores.h, `${size}: nothing above the marking bar: ${JSON.stringify(box)}`)
  }

  assert.equal(recoloured.code, 1, `a highlight in another colour is a difference: ${recoloured.output}`)
  const names = named(recoloured.pair('marked/desktop'))
  assert.equal(names.length, 1, `one element is named: ${names.join(' | ')}`)
  assert.match(names[0], highlightOf('keep', LOVED))
})

test('N4 — What honestly varies between two runs raises no alarm', async () => {
  const DELAY = 1200
  const WEEKS_AHEAD = 40 * 24 * 60 * 60 * 1000
  stub.byDefault({ json: FIX_RESPONSE, delayMs: DELAY, usage: { prompt_tokens: 12345, completion_tokens: 6789 } })
  // The server's calendar, moved on before any of its code runs; elapsed times are differences and stay true.
  const clock = `const Real = Date
    globalThis.Date = class extends Real {
      constructor(...args) { args.length ? super(...args) : super(Real.now() + ${WEEKS_AHEAD}) }
      static now() { return Real.now() + ${WEEKS_AHEAD} }
    }`
  const later = await startApp({
    stub,
    env: { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=data:text/javascript,${encodeURIComponent(clock)}`.trim() },
  })
  try {
    // What the screens are about to show really is different from what was approved.
    const slow = await later.fix(BLOG_PROMPT, { intent: 'writing', strength: 'balanced' })
    assert.ok(slow.body.meta.elapsedMs >= DELAY, `the fix took ${slow.body.meta.elapsedMs} ms`)
    assert.equal(slow.body.meta.usage.inputTokens, 12345)

    const run = await check('varies', { app: later, baselines: approved, screens: ['fixed/desktop', 'changes/desktop', 'library/desktop'] })
    assert.equal(run.code, 0, `${run.output}\n${seen(run.pairs)}`)
    assert.equal(run.pairs.length, 3)
    for (const pair of run.pairs) assert.deepEqual(pair.regions, [], `${pair.id}: ${JSON.stringify(pair.regions.map((r) => r.boxBaseline))}`)

    // The Library screen was the last one captured; its saved prompt is dated weeks from now.
    const [saved] = (await later.get('/api/library')).body.entries
    assert.ok(saved, 'the Library screen saved a prompt')
    assert.ok(new Date(saved.updatedAt).getTime() - Date.now() > WEEKS_AHEAD / 2, `saved on ${saved.updatedAt}`)
  } finally {
    await later.stop()
  }
})

test('N5 — A screen with no approved picture, or a changed look, fails the check until I approve it', async () => {
  // The empty screen has its approved picture; the Issues screen has none. Both now show a restyled button.
  const pictures = picturesWith('pictures-approving', 'empty/small')
  const mine = { baselines: pictures, screens: ['empty/small', 'issues/small'], variant: 'fix-button' }

  const first = await npmRun('visual', 'approving-1', mine)
  assert.equal(first.code, 1, first.output)
  assert.equal(first.pair('issues/small').status, 'new', seen(first.pairs))
  assert.match(first.pair('issues/small').failReasons.join(' '), /no baseline/, 'a missing picture is a reason to fail, not a pass')
  assert.equal(first.pair('empty/small').status, 'failed', seen(first.pairs))
  assert.ok(named(first.pair('empty/small')).some((n) => FIX_BUTTON.test(n)), `the button is named: ${named(first.pair('empty/small')).join(' | ')}`)

  const approve = await npmRun('visual:approve', 'approving-2', mine)
  assert.equal(approve.code, 0, approve.output)

  const second = await npmRun('visual', 'approving-3', mine)
  assert.equal(second.code, 0, `${second.output}\n${seen(second.pairs)}`)
  for (const pair of second.pairs) assert.equal(pair.status, 'passed', seen(second.pairs))
  assert.equal(second.pairs.length, 2)
})

test('N6 — The one command hands back the verdict and leaves nothing running', async () => {
  // Each run keeps its temporary files in a place of its own, so what it leaves there can be seen.
  const places = ['clean', 'changed', 'mistyped', 'against'].map((name) => fs.mkdtempSync(path.join(tmp, `${name}-`)))
  const mine = { baselines: approved, screens: ['empty/small'] }
  // Nobody approved anything for the fourth run: the commit's own screens are its pictures, for that run only.
  const nobodys = emptyFolder('pictures-nobody-approved')
  // Four runs at once: they share nothing but the approved pictures, which none of them writes.
  const [clean, changed, mistyped, against] = await Promise.all([
    npmRun('visual', 'verdict-clean', { ...mine, tmp: places[0] }),
    npmRun('visual', 'verdict-changed', { ...mine, tmp: places[1], variant: 'fix-button' }),
    npmRun('visual', 'verdict-mistyped', { ...mine, tmp: places[2], screens: ['emtpy/small'] }),
    npmRun('visual', 'verdict-against', { baselines: nobodys, screens: ['empty/small'], tmp: places[3], variant: 'fix-button', flags: ['--against', 'HEAD'] }),
  ])

  assert.equal(clean.code, 0, clean.output)
  assert.equal(clean.pair('empty/small').status, 'passed')

  assert.equal(changed.code, 1, changed.output)
  assert.equal(changed.pair('empty/small').status, 'failed')
  const junit = fs.readFileSync(path.join(changed.out, 'junit.xml'), 'utf8')
  assert.match(junit, /<failure/, 'the report for CI carries the failure')
  assert.match(junit, /Fix prompt/, 'and the element behind it')

  assert.equal(mistyped.code, 2, mistyped.output)
  assert.match(mistyped.output, /unknown target "emtpy\/small"/)
  for (const screen of SCREENS) assert.ok(mistyped.output.includes(screen), `the screens there are: ${mistyped.output}`)

  // Against the commit: the restyled button is the working tree's alone, so it is what the report names.
  assert.equal(against.code, 1, against.output)
  assert.equal(against.pair('empty/small').status, 'failed', seen(against.pairs))
  assert.ok(named(against.pair('empty/small')).some((locator) => FIX_BUTTON.test(locator)), `named: ${named(against.pair('empty/small')).join(' | ')}`)
  assert.match(against.output, /== the commit: HEAD \([0-9a-f]{7}\)/, 'it says which commit it compared with')
  // The folder it was told to keep pictures in was never even made.
  assert.deepEqual(fs.existsSync(nobodys) ? fs.readdirSync(nobodys) : [], [], 'and it approved nothing on the way')
  assert.deepEqual(stillCheckedOut(), [], 'the commit it built and served is put away again')

  for (const run of [clean, changed, against]) {
    const served = run.pairs[0].candidate.source
    assert.match(served, /^http:\/\/127\.0\.0\.1:\d+\/$/)
    assert.equal(await answers(served), false, `${served} still answers`)
  }
  for (const place of places) assert.deepEqual(leftIn(place), [], 'the server it started has been stopped and its folders removed')
})

test('N7 — Pointed at the wrong place, the check says so and harms nothing', async () => {
  const nowhere = await check('nowhere', { app: { base: '' }, baselines: approved, screens: ['empty/small'] })
  assert.equal(nowhere.code, 2, nowhere.output)
  assert.match(nowhere.output, /npm run visual/)
  assert.deepEqual(nowhere.pairs, [], 'nothing was captured')

  // A PromptFixer that was not started for a test: its models live in a folder of its own.
  const models = fs.mkdtempSync(path.join(tmp, 'somebodys-models-'))
  const inUse = await startApp({ stub, env: { PROMPTFIXER_MODEL_DIR: models } })
  try {
    const mine = (await inUse.post('/api/library', libraryEntry())).body.entry
    const run = await check('in-use', { app: inUse, baselines: approved, screens: ['empty/small'] })
    assert.equal(run.code, 2, `${run.output}\n${seen(run.pairs)}`)
    assert.match(run.pair('empty/small').error, /library is left alone/)
    const entries = (await inUse.get('/api/library')).body.entries
    assert.deepEqual(entries.map((e) => e.id), [mine.id], 'the saved prompt is still there')
  } finally {
    await inUse.stop()
  }
})
