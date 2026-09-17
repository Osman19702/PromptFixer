#!/usr/bin/env node
/**
 * The visual check with Elastishot: build the interface, start the stub
 * provider and the real server (acceptance/support: OS-assigned ports, private
 * temp data and model folders), and run the targets of elastishot.config.mjs.
 *
 *   npm run visual                     compare every screen with its approved picture
 *   npm run visual -- fixed marked     only these targets; fixed/small is one viewport of one
 *   npm run visual -- --no-build       use dist/ as it is
 *   npm run visual:approve             approve the current look (of every target, or of the named ones)
 *   npm run visual -- --against master compare with a commit instead: what did my change do to the interface?
 *
 * Exit codes are Elastishot's: 0 no differences, 1 differences or a missing
 * picture (the report is the index.html in the folder .elastishot/runs/latest
 * names), 2 error. The pictures live under .elastishot/baselines and are not
 * committed: fonts render differently from machine to machine, so approve
 * them on the machine that runs the check.
 *
 * --against needs no approved pictures, which is why CI uses it. The ref (a
 * branch, a tag, a commit) is checked out into .elastishot/against/<sha>, built
 * there and served by ITS OWN server and stub; its screens become the pictures
 * of this one run; then the working tree is captured and compared with them.
 * Both sides are captured on the same machine in the same run, so fonts and
 * the browser cancel out. The checkout sits inside the project so that it
 * finds the project's node_modules: a ref whose dependencies differ in a way
 * its build or its server notices cannot be compared like this. A screen the
 * ref cannot be driven to (it did not exist yet) has no picture and is
 * reported as new.
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)
const CONFIG = path.join(root, 'elastishot.config.mjs')

export const USAGE = `Usage: node scripts/visual.mjs [--update | --against <ref>] [--no-build] [--out <dir>] [target[/viewport]...]

  --update         approve: write the pictures that are missing and promote the ones that changed
  --against <ref>  compare with that commit (branch, tag, sha) instead of with the approved pictures
  --no-build       skip "vite build" and check dist/ as it is
  --out <dir>      the run folder (default: .elastishot/runs/<time>)
  target           a target of elastishot.config.mjs, or target/viewport (default: all of them)`

/** The runner's own flags, then target names. Throws on anything else, so a typo cannot pass as a target. */
export function parseArgs(argv) {
  const args = { update: false, build: true, help: false, out: null, against: null, targets: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--update') args.update = true
    else if (arg === '--no-build') args.build = false
    else if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--out') {
      const dir = argv[++i]
      if (!dir || dir.startsWith('-')) throw new Error('--out needs a folder')
      args.out = dir
    } else if (arg === '--against') {
      const ref = argv[++i]
      if (!ref || ref.startsWith('-')) throw new Error('--against needs a branch, a tag or a commit')
      args.against = ref
    } else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`)
    else args.targets.push(arg)
  }
  // An approval keeps pictures; a comparison with a commit throws its pictures away afterwards.
  if (args.update && args.against) throw new Error('--update and --against do not go together')
  return args
}

/** The Elastishot command line for the run. */
export function runArgs(args, config = CONFIG) {
  return [
    'run',
    '--config',
    config,
    '--junit',
    ...(args.out ? ['--out', args.out] : []),
    ...(args.update ? ['--update'] : []),
    ...args.targets,
  ]
}

/**
 * Promotes every failed pair of the run in `runDir`. Named, not Elastishot's
 * "latest": that pointer is shared by every run of this checkout, and one that
 * finished in between (Group N, a second terminal) would be approved instead.
 */
export function approveArgs(runDir, config = CONFIG) {
  return ['approve', runDir, '--all', '--config', config]
}

/** A run folder of the runner's choosing, named the way Elastishot names its own under the config's outDir. */
export const runFolder = (date = new Date()) =>
  path.join(root, '.elastishot', 'runs', date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-'))

/**
 * `run --update` writes the pictures that are missing but still compares — and
 * fails — the ones that exist, so an approval of a changed look needs a second step.
 */
export const needsApproval = (args, code) => args.update && code === 1

/** Elastishot's exit code is the runner's; a child that was killed has none, which is an error. */
export const exitCodeOf = (code) => (Number.isInteger(code) ? code : 2)

/** Where --against checks the ref out: inside the project, so the checkout resolves the project's node_modules. */
export const againstFolder = (sha) => path.join(root, '.elastishot', 'against', String(sha).slice(0, 12))

/**
 * What the ref's own capture run came to: which screens have a picture now and
 * which could not be driven there. None at all means the ref is out of this
 * config's reach (older than the hooks the drivers wait for), not "all new".
 */
export function picturesOf(report) {
  const pairs = Array.isArray(report?.pairs) ? report.pairs : []
  const label = (p) => `${p.name}${p.viewport?.name ? ` [${p.viewport.name}]` : ''}`
  const missing = pairs.filter((p) => p.status === 'error')
  return { taken: pairs.length - missing.length, missing: missing.map(label) }
}

/** A Markdown table of the comparison for the GitHub job summary, from the run's report.json. */
export function summarise(report, ref) {
  const pairs = Array.isArray(report?.pairs) ? report.pairs : []
  const totals = report?.totals ?? {}
  // A locator can hold a pipe or a backtick (an accessible name does); neither may end the cell.
  const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/`/g, "'")
  const rows = pairs.map((p) => {
    const s = p.summary
    const score = s ? `${(s.similarity * 100).toFixed(1)}%` : '—'
    const counts = s ? `+${s.counts.added} −${s.counts.removed} ~${s.counts.changed} ›${s.counts.moved}` : ''
    const named = (p.locators?.changedLocators ?? [])
      .filter((l) => (l.evidence ?? []).includes('pixels'))
      .slice(0, 3)
      .map((l) => `\`${cell(l.locator)}\``)
      .join(', ')
    return `| ${cell(p.name)} | ${p.viewport?.name ?? ''} | ${p.status} | ${score} | ${counts} | ${named} |`
  })
  return [
    `### Interface compared with \`${cell(ref)}\``,
    '',
    `${totals.passed ?? 0} the same, ${totals.failed ?? 0} with differences, ${totals.new ?? 0} new, ${totals.errors ?? 0} errors. The full report is in the \`elastishot-report\` artifact.`,
    '',
    '| Screen | Window | Result | Similarity | Regions | Elements |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n')
}

function build(cwd = root) {
  const vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js')
  execFileSync(process.execPath, [vite, 'build'], { cwd, stdio: 'inherit' })
}

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

export async function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (err) {
    console.error(`visual: ${err.message}\n${USAGE}`)
    return 2
  }
  if (args.help) {
    console.log(USAGE)
    return 0
  }

  const bin = path.join(path.dirname(require.resolve('elastishot/package.json')), 'bin', 'elastishot.js')
  // Whatever is running or lying about right now, newest first; everything in it is safe to call twice.
  const undo = []
  const cleanUp = async () => {
    while (undo.length) await undo.pop()().catch(() => {})
  }
  // Not splice(indexOf()) on its own: that is -1 once cleanUp() has taken the step, and would drop another one.
  const forgetStep = (step) => {
    const at = undo.indexOf(step)
    if (at >= 0) undo.splice(at, 1)
  }
  // Ctrl+C must not leave a server, two temp folders or a checkout behind.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => cleanUp().finally(() => process.exit(130)))
  }

  /** The stub provider and the real server of the tree in `dir`; imported from there, because a ref is served by its own code. */
  const serve = async (dir) => {
    const support = (file) => pathToFileURL(path.join(dir, 'acceptance', 'support', file)).href
    // Imported here, not at the top: the tests import this file for its pure parts.
    const { startStub } = await import(support('stub-provider.js'))
    const { startApp } = await import(support('app.js'))
    const stub = await startStub()
    const closeStub = () => stub.close()
    undo.push(closeStub)
    const app = await startApp({ stub })
    const stopApp = () => app.stop()
    undo.push(stopApp)
    return {
      base: app.base,
      /** Both down now, not at the end: the next pair of servers should not find these still up. */
      async stop() {
        for (const step of [stopApp, closeStub]) {
          forgetStep(step)
          await step().catch(() => {})
        }
      },
    }
  }

  const elastishot = (app, cliArgs, env = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bin, ...cliArgs], {
        cwd: root,
        stdio: 'inherit',
        env: { ...process.env, ...env, PROMPTFIXER_VISUAL_URL: app.base },
      })
      const stop = async () => child.kill()
      undo.push(stop)
      child.on('error', reject)
      child.on('exit', (code) => {
        forgetStep(stop)
        resolve(exitCodeOf(code))
      })
    })

  try {
    if (args.against) return await against(args, { serve, elastishot, undo, cleanUp })

    // An approval has to know which run it promotes from.
    if (args.update && !args.out) args.out = runFolder()

    if (args.build) build()
    else if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) {
      console.error('visual: dist/ has no build to check; run without --no-build')
      return 2
    }

    const app = await serve(root)
    let code = await elastishot(app, runArgs(args))
    if (needsApproval(args, code)) {
      console.log('visual: approving the screens that changed')
      code = await elastishot(app, approveArgs(args.out))
    }
    return code
  } finally {
    await cleanUp()
  }
}

/** --against: the ref's screens become the pictures of this one run, then the working tree is compared with them. */
async function against(args, { serve, elastishot, undo, cleanUp }) {
  let sha
  try {
    sha = git('rev-parse', '--verify', '--quiet', `${args.against}^{commit}`)
  } catch {
    console.error(`visual: "${args.against}" is not a commit this checkout has (fetch it first; a CI checkout needs fetch-depth: 0)`)
    return 2
  }

  if (args.build) build()
  else if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) {
    console.error('visual: dist/ has no build to check; run without --no-build')
    return 2
  }

  const checkout = againstFolder(sha)
  const forget = async () => {
    try {
      git('worktree', 'remove', '--force', checkout)
    } catch {
      /* never added, or already gone */
    }
    fs.rmSync(checkout, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    try {
      git('worktree', 'prune')
    } catch {
      /* nothing to prune */
    }
  }
  // One that an interrupted run left behind would make "worktree add" refuse.
  await forget()
  undo.push(forget)
  git('worktree', 'add', '--detach', checkout, sha)
  if (!fs.existsSync(path.join(checkout, 'acceptance', 'support', 'app.js'))) {
    console.error(`visual: ${args.against} has no acceptance harness (acceptance/support) to start its server with`)
    return 2
  }
  console.log(`\n== the commit: ${args.against} (${sha.slice(0, 7)}), built and served from ${path.relative(root, checkout)}`)
  build(checkout)

  const scratch = (prefix) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    undo.push(async () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
    return dir
  }
  const pictures = { PROMPTFIXER_VISUAL_BASELINES: scratch('promptfixer-visual-pictures-') }
  // Its own folder, outside .elastishot/runs: that folder, and the CI artifact made of it, hold the comparison only.
  const taking = scratch('promptfixer-visual-taking-')

  const before = await serve(checkout)
  // A deliberate regression (PROMPTFIXER_VISUAL_VARIANT) is the working tree's: restyling both sides would cancel it out.
  const took = await elastishot(before, ['run', '--config', CONFIG, '--update', '--out', taking, ...args.targets], { ...pictures, PROMPTFIXER_VISUAL_VARIANT: '' })
  if (!fs.existsSync(path.join(taking, 'report.json'))) {
    console.error(`visual: capturing ${args.against} wrote no report (exit ${took}); the lines above say why`)
    return 2
  }
  const { taken, missing } = picturesOf(JSON.parse(fs.readFileSync(path.join(taking, 'report.json'), 'utf8')))
  if (!taken) {
    console.error(`visual: no screen of ${args.against} could be captured (exit ${took}); it is probably older than the hooks elastishot.config.mjs drives the page by`)
    return 2
  }
  if (missing.length) console.log(`visual: not reachable in ${args.against}, so reported as new: ${missing.join(', ')}`)
  // The ref's server has done its part.
  await before.stop()

  console.log('\n== the working tree')
  const after = await serve(root)
  const out = args.out ?? runFolder()
  const code = await elastishot(after, ['run', '--config', CONFIG, '--junit', '--out', out, ...args.targets], pictures)
  const reportFile = path.join(out, 'report.json')
  if (process.env.GITHUB_STEP_SUMMARY && fs.existsSync(reportFile)) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summarise(JSON.parse(fs.readFileSync(reportFile, 'utf8')), args.against))
  }
  await cleanUp()
  return code
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(
    await main(process.argv.slice(2)).catch((err) => {
      console.error(`visual: ${err.message}`)
      return 2
    })
  )
}
