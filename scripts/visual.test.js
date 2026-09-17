import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startApp } from '../acceptance/support/app.js'
import { againstFolder, approveArgs, exitCodeOf, needsApproval, parseArgs, picturesOf, runArgs, runFolder, summarise, USAGE } from './visual.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(here, 'visual.mjs')
const CONFIG = path.join(here, '..', 'elastishot.config.mjs')
const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })

// The config reads its environment once, when it is imported; a query string makes each import a fresh one.
let imports = 0
async function loadConfig(env) {
  const saved = { ...process.env }
  delete process.env.PROMPTFIXER_VISUAL_URL
  delete process.env.PROMPTFIXER_VISUAL_BASELINES
  delete process.env.PROMPTFIXER_VISUAL_VARIANT
  Object.assign(process.env, env)
  try {
    return (await import(`${pathToFileURL(CONFIG).href}?load=${++imports}`)).default
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  }
}

test('no arguments: build, compare every target', () => {
  assert.deepEqual(parseArgs([]), { update: false, build: true, help: false, out: null, against: null, targets: [] })
})

test('flags may come in any order; everything else is a target', () => {
  const args = parseArgs(['--no-build', 'fixed', '--update', 'marked/small', '--out', '.elastishot/runs/mine'])
  assert.deepEqual(args, { update: true, build: false, help: false, out: '.elastishot/runs/mine', against: null, targets: ['fixed', 'marked/small'] })
})

test('an unknown option is an error, not a target', () => {
  assert.throws(() => parseArgs(['--updat']), /unknown option --updat/)
  assert.throws(() => parseArgs(['--out']), /--out needs a folder/)
  assert.throws(() => parseArgs(['--out', '--update']), /--out needs a folder/)
})

test('the Elastishot command line: run, the config, JUnit, then the targets', () => {
  assert.deepEqual(runArgs(parseArgs([]), 'cfg.mjs'), ['run', '--config', 'cfg.mjs', '--junit'])
  assert.deepEqual(runArgs(parseArgs(['--update', 'fixed', 'diff/small']), 'cfg.mjs'), [
    'run',
    '--config',
    'cfg.mjs',
    '--junit',
    '--update',
    'fixed',
    'diff/small',
  ])
  assert.deepEqual(runArgs(parseArgs(['--out', 'there', 'empty']), 'cfg.mjs'), ['run', '--config', 'cfg.mjs', '--junit', '--out', 'there', 'empty'])
  // --no-build is the runner's own business
  assert.ok(!runArgs(parseArgs(['--no-build'])).includes('--no-build'))
  assert.equal(path.basename(runArgs(parseArgs([]))[2]), 'elastishot.config.mjs')
})

test('approving promotes what failed, and only after an --update run that found differences', () => {
  // from the run it names: Elastishot's "latest" may by then be somebody else's run
  assert.deepEqual(approveArgs('runs/mine', 'cfg.mjs'), ['approve', 'runs/mine', '--all', '--config', 'cfg.mjs'])
  const folder = runFolder(new Date('2026-09-17T14:49:38.123Z'))
  assert.equal(path.basename(folder), '2026-09-17T14-49-38Z')
  assert.equal(path.relative(path.join(here, '..'), path.dirname(folder)), path.join('.elastishot', 'runs'))
  assert.equal(needsApproval(parseArgs(['--update']), 1), true)
  assert.equal(needsApproval(parseArgs(['--update']), 0), false)
  // an error is never approved away
  assert.equal(needsApproval(parseArgs(['--update']), 2), false)
  assert.equal(needsApproval(parseArgs([]), 1), false)
})

test("Elastishot's exit code is passed through; a killed run is an error", () => {
  assert.equal(exitCodeOf(0), 0)
  assert.equal(exitCodeOf(1), 1)
  assert.equal(exitCodeOf(2), 2)
  assert.equal(exitCodeOf(null), 2)
  assert.equal(exitCodeOf(undefined), 2)
})

// --- compared with a commit instead of with approved pictures -------------------------

test('--against names a commit to compare with, and takes targets like any run', () => {
  const args = parseArgs(['--against', 'origin/master', '--no-build', 'fixed/small'])
  assert.deepEqual(args, { update: false, build: false, help: false, out: null, against: 'origin/master', targets: ['fixed/small'] })
  assert.throws(() => parseArgs(['--against']), /--against needs a branch, a tag or a commit/)
  assert.throws(() => parseArgs(['--against', '--no-build']), /--against needs a branch/)
  // An approval keeps pictures; this mode throws its pictures away when it is done.
  assert.throws(() => parseArgs(['--update', '--against', 'master']), /do not go together/)
  assert.throws(() => parseArgs(['--against', 'master', '--update']), /do not go together/)
})

test('the commit is checked out inside the project, where it finds node_modules, under an ignored folder', () => {
  const folder = againstFolder('ee23dd08c9229f361c99cb4f5206376895173d62')
  assert.equal(path.relative(path.join(here, '..'), folder), path.join('.elastishot', 'against', 'ee23dd08c922'))
  assert.match(fs.readFileSync(path.join(here, '..', '.gitignore'), 'utf8'), /^\.elastishot\/$/m)
})

test('a commit that cannot be found is said so before anything is built or started', () => {
  const lost = run(['--against', 'no-such-ref-7f3a', '--no-build'])
  assert.equal(lost.status, 2)
  assert.match(lost.stderr, /visual: "no-such-ref-7f3a" is not a commit this checkout has/)
  assert.match(lost.stderr, /fetch-depth: 0/)
  assert.equal(lost.stdout, '', 'nothing was built and no server spoke')
})

const pair = (name, size, status, extra = {}) => ({ name, viewport: { name: size }, status, ...extra })

test('what the commit could show: a screen it cannot be driven to has no picture, and none at all is an error', () => {
  const some = { pairs: [pair('fixed', 'desktop', 'new'), pair('marked', 'desktop', 'error'), pair('marked', 'small', 'error')] }
  assert.deepEqual(picturesOf(some), { taken: 1, missing: ['marked [desktop]', 'marked [small]'] })
  assert.deepEqual(picturesOf({ pairs: [pair('empty', 'small', 'error')] }), { taken: 0, missing: ['empty [small]'] })
  for (const nothing of [undefined, null, {}, { pairs: 'no' }]) assert.deepEqual(picturesOf(nothing), { taken: 0, missing: [] })
})

test('the job summary: one row a pair, the elements named by their pixels, and a cell no locator can break out of', () => {
  const report = {
    totals: { passed: 1, failed: 1, new: 1, errors: 0 },
    pairs: [
      pair('empty', 'desktop', 'passed', { summary: { similarity: 1, counts: { added: 0, removed: 0, changed: 0, moved: 0 } } }),
      pair('fixed', 'small', 'failed', {
        summary: { similarity: 0.9712, counts: { added: 1, removed: 0, changed: 2, moved: 0 } },
        locators: {
          changedLocators: [
            { locator: 'testid=rewrite', evidence: ['pixels'] },
            { locator: 'role=button[name="Keep | `it`"]', evidence: ['pixels', 'map'] },
            { locator: 'testid=only-in-the-map', evidence: ['map'] },
          ],
        },
      }),
      pair('marked', 'small', 'new'),
    ],
  }
  const lines = summarise(report, 'origin/master').split('\n')
  assert.equal(lines[0], '### Interface compared with `origin/master`')
  assert.match(lines[2], /^1 the same, 1 with differences, 1 new, 0 errors\. The full report is in the `elastishot-report` artifact\.$/)
  assert.equal(lines[4], '| Screen | Window | Result | Similarity | Regions | Elements |')
  assert.equal(lines[6], '| empty | desktop | passed | 100.0% | +0 −0 ~0 ›0 |  |')
  // Only what the pixels showed is named, and a pipe or a backtick in an accessible name stays inside its cell.
  assert.equal(lines[7], '| fixed | small | failed | 97.1% | +1 −0 ~2 ›0 | `testid=rewrite`, `role=button[name="Keep \\| \'it\'"]` |')
  assert.equal(lines[8], '| marked | small | new | — |  |  |')
  assert.equal(lines.filter((l) => l.startsWith('| ')).length, 4, 'a header and one row a pair')
  assert.doesNotThrow(() => summarise(undefined, 'x'))
})

test('--help prints the usage and starts nothing; a bad option exits 2 with it', () => {
  const help = run(['--help'])
  assert.equal(help.status, 0)
  assert.equal(help.stdout.trim(), USAGE)
  const bad = run(['--frobnicate'])
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /visual: unknown option --frobnicate/)
  assert.match(bad.stderr, /Usage: node scripts\/visual\.mjs/)
})

test('the config without a server URL says how to run the check', async () => {
  await assert.rejects(loadConfig({}), /PROMPTFIXER_VISUAL_URL is not set.*npm run visual/s)
})

test('the config: seven screens at two sizes, each reached by a driver, against the given server', async () => {
  const config = await loadConfig({ PROMPTFIXER_VISUAL_URL: 'http://127.0.0.1:4321/' })
  assert.deepEqual(config.targets.map((t) => t.name), ['empty', 'issues', 'fixed', 'marked', 'diff', 'changes', 'library'])
  for (const t of config.targets) {
    assert.equal(t.url, 'http://127.0.0.1:4321/')
    assert.equal(typeof t.capture.waitFor, 'function', `${t.name} is driven, not slept for`)
  }
  assert.deepEqual(config.viewports, [
    { name: 'desktop', width: 1360, height: 880 },
    { name: 'small', width: 1024, height: 720 },
  ])
  assert.equal(config.threshold, 0.98)
  assert.equal(config.baselineDir, '.elastishot/baselines')
  assert.equal(config.outDir, '.elastishot/runs')
  // what differs between two honest captures stays off the picture
  assert.ok(config.capture.hide.some((s) => s.includes('toasts')))
  assert.ok(config.capture.hide.some((s) => s.includes('library-entry-date')))
  assert.ok(config.capture.mask.some((s) => s.includes('run-details')))
})

test('the config takes its baselines folder and its variant from the environment', async () => {
  const config = await loadConfig({
    PROMPTFIXER_VISUAL_URL: 'http://127.0.0.1:4321',
    PROMPTFIXER_VISUAL_BASELINES: '.elastishot/runs/acceptance-baselines',
    PROMPTFIXER_VISUAL_VARIANT: 'keep-colour',
  })
  assert.equal(config.baselineDir, '.elastishot/runs/acceptance-baselines')
  // "PROMPTFIXER_VISUAL_BASELINES= npm run visual:approve" must not approve into the project root
  for (const blank of ['', '   ']) {
    const unset = await loadConfig({ PROMPTFIXER_VISUAL_URL: 'http://127.0.0.1:4321', PROMPTFIXER_VISUAL_BASELINES: blank })
    assert.equal(unset.baselineDir, '.elastishot/baselines', `baselines folder for ${JSON.stringify(blank)}`)
  }
  await assert.rejects(
    loadConfig({ PROMPTFIXER_VISUAL_URL: 'http://127.0.0.1:4321', PROMPTFIXER_VISUAL_VARIANT: 'nope' }),
    /"nope" is not a variant \(known: keep-colour, marks-plain, rewrite-type, fix-button\)/
  )
})

// --- the server the check starts -------------------------------------------------

// A start that fails hands its caller no stop(), so startApp has to leave nothing
// behind by itself. The temp folder is pointed at an empty one to see what it left.
async function inEmptyTemp(body) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promptfixer-visual-test-'))
  const saved = { TMP: process.env.TMP, TEMP: process.env.TEMP, TMPDIR: process.env.TMPDIR }
  Object.assign(process.env, { TMP: tmp, TEMP: tmp, TMPDIR: tmp })
  try {
    return await body(tmp)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

test('a server that exits before it is ready leaves no folders behind', async () => {
  await inEmptyTemp(async (tmp) => {
    // a preload that quits: the server is gone before it can say it is ready, without a word on stderr
    const quit = path.join(tmp, 'quit.cjs')
    fs.writeFileSync(quit, 'process.exit(3)\n')
    const preload = `--require "${quit.split(path.sep).join('/')}"`
    await assert.rejects(startApp({ env: { NODE_OPTIONS: preload } }), /server exited with code 3 before it was ready/)
    assert.deepEqual(fs.readdirSync(tmp), ['quit.cjs'])
  })
})

test('a server that cannot be spawned leaves no folders behind', async () => {
  await inEmptyTemp(async (tmp) => {
    const node = process.execPath
    process.execPath = path.join(tmp, 'no-such-node')
    try {
      // the "error" path: there is no process to stop, only the folders to remove
      await assert.rejects(startApp(), { code: 'ENOENT' })
    } finally {
      process.execPath = node
    }
    assert.deepEqual(fs.readdirSync(tmp), [])
  })
})
