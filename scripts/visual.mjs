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
 *
 * Exit codes are Elastishot's: 0 no differences, 1 differences or a missing
 * picture (the report is the index.html in the folder .elastishot/runs/latest
 * names), 2 error. The pictures live under .elastishot/baselines and are not
 * committed: fonts render differently from machine to machine, so approve
 * them on the machine that runs the check.
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)
const CONFIG = path.join(root, 'elastishot.config.mjs')

export const USAGE = `Usage: node scripts/visual.mjs [--update] [--no-build] [--out <dir>] [target[/viewport]...]

  --update     approve: write the pictures that are missing and promote the ones that changed
  --no-build   skip "vite build" and check dist/ as it is
  --out <dir>  the run folder (default: .elastishot/runs/<time>)
  target       a target of elastishot.config.mjs, or target/viewport (default: all of them)`

/** The runner's own flags, then target names. Throws on anything else, so a typo cannot pass as a target. */
export function parseArgs(argv) {
  const args = { update: false, build: true, help: false, out: null, targets: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--update') args.update = true
    else if (arg === '--no-build') args.build = false
    else if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--out') {
      const dir = argv[++i]
      if (!dir || dir.startsWith('-')) throw new Error('--out needs a folder')
      args.out = dir
    } else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`)
    else args.targets.push(arg)
  }
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

function build() {
  const vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js')
  execFileSync(process.execPath, [vite, 'build'], { cwd: root, stdio: 'inherit' })
}

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

  // An approval has to know which run it promotes from.
  if (args.update && !args.out) args.out = runFolder()

  if (args.build) build()
  else if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) {
    console.error('visual: dist/ has no build to check; run without --no-build')
    return 2
  }

  // Imported here, not at the top: the tests import this file for its pure parts.
  const { startStub } = await import('../acceptance/support/stub-provider.js')
  const { startApp } = await import('../acceptance/support/app.js')
  const bin = path.join(path.dirname(require.resolve('elastishot/package.json')), 'bin', 'elastishot.js')

  let stub = null
  let app = null
  let child = null
  const shutDown = async () => {
    child?.kill()
    await app?.stop()
    await stub?.close()
    app = stub = null
  }
  // Ctrl+C must not leave a server and two temp folders behind.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => shutDown().finally(() => process.exit(130)))
  }

  const elastishot = (cliArgs) =>
    new Promise((resolve, reject) => {
      const env = { ...process.env, PROMPTFIXER_VISUAL_URL: app.base }
      child = spawn(process.execPath, [bin, ...cliArgs], { cwd: root, stdio: 'inherit', env })
      child.on('error', reject)
      child.on('exit', (code) => resolve(exitCodeOf(code)))
    })

  try {
    stub = await startStub()
    app = await startApp({ stub })
    let code = await elastishot(runArgs(args))
    if (needsApproval(args, code)) {
      console.log('visual: approving the screens that changed')
      code = await elastishot(approveArgs(args.out))
    }
    return code
  } finally {
    await shutDown()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(
    await main(process.argv.slice(2)).catch((err) => {
      console.error(`visual: ${err.message}`)
      return 2
    })
  )
}
