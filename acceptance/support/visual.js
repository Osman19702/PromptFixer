/**
 * Runs the visual check the way a developer's machine does — the real
 * Elastishot CLI, or the npm script around it, as a subprocess — and reads the
 * report it wrote.
 *
 * Everything lands under .elastishot/runs/acceptance-*: the run folders and the
 * approved pictures the scenarios compare against. A developer's own
 * .elastishot/baselines is never read and never written.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLI = path.join(path.dirname(require.resolve('elastishot/package.json')), 'bin', 'elastishot.js')
const CONFIG = path.join(root, 'elastishot.config.mjs')
const SCRIPTS = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts

/** The screens of elastishot.config.mjs and the two window sizes, by the names a developer types. */
export const SCREENS = ['empty', 'issues', 'fixed', 'marked', 'diff', 'changes', 'library']
export const SIZES = ['desktop', 'small']

/** A folder under .elastishot/runs for one scenario's run or pictures. */
const folder = (name) => path.join(root, '.elastishot', 'runs', `acceptance-${name}`)

/** The same, emptied: a picture left by an earlier run would be compared against, not replaced. */
export function emptyFolder(name) {
  const dir = folder(name)
  fs.rmSync(dir, { recursive: true, force: true })
  return dir
}

/**
 * Never the synchronous spawn: the scripted model lives in this process, and a
 * blocked event loop could not answer the page the check is driving.
 */
const spawned = (script, args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      env: { ...process.env, PROMPTFIXER_VISUAL_VARIANT: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (d) => (output += d))
    child.stderr.on('data', (d) => (output += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, output }))
  })

const readReport = (out) => {
  const file = path.join(out, 'report.json')
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
}

/** What a run did, with its pairs by "screen/size". */
const outcome = ({ code, output }, out) => {
  const report = readReport(out)
  const pairs = report?.pairs ?? []
  return {
    code,
    output,
    out,
    pairs,
    pair: (key) => pairs.find((p) => `${p.target}/${p.viewport?.name}` === key) ?? null,
  }
}

/**
 * `elastishot run` over the named screens ("fixed", "fixed/desktop"; none means
 * all of them) against the server of `app`, compared with the pictures in
 * `baselines`; with `update`, screens that have no picture yet are given one.
 */
export async function check(name, { app, baselines, screens = [], update = false, variant = '' }) {
  const out = emptyFolder(name)
  const args = ['run', '--config', CONFIG, '--out', out, '--quiet', ...(update ? ['--update'] : []), ...screens]
  const env = { PROMPTFIXER_VISUAL_URL: app.base, PROMPTFIXER_VISUAL_BASELINES: baselines, PROMPTFIXER_VISUAL_VARIANT: variant }
  return outcome(await spawned(CLI, args, env), out)
}

/** `elastishot compare` of two approved pictures (each a folder: the picture and its element map). */
export async function comparePictures(name, baseline, candidate) {
  const out = emptyFolder(name)
  const args = ['compare', baseline, candidate, '--name', name, '--out', out, '--quiet']
  // The CLI loads the project's config from the working folder, and the config insists on a server; none is contacted.
  const compared = outcome(await spawned(CLI, args, { PROMPTFIXER_VISUAL_URL: 'http://127.0.0.1:9' }), out)
  return { ...compared, pair: () => compared.pairs[0] ?? null }
}

/**
 * "npm run visual" or "npm run visual:approve", as package.json spells them and
 * without npm in between: the runner starts its own scripted model and server.
 * dist/ is built already (the suite's precondition), so the build is skipped.
 * With `tmp`, its temporary folders go where the scenario can see what is left.
 */
export async function npmRun(script, name, { screens = [], baselines, variant = '', tmp, flags: more = [] } = {}) {
  const [node, file, ...flags] = String(SCRIPTS[script]).split(' ')
  if (node !== 'node' || !file) throw new Error(`package.json "${script}" is not a node script: ${SCRIPTS[script]}`)
  const out = emptyFolder(name)
  const env = {
    PROMPTFIXER_VISUAL_BASELINES: baselines,
    PROMPTFIXER_VISUAL_VARIANT: variant,
    ...(tmp ? { TMP: tmp, TEMP: tmp, TMPDIR: tmp } : {}),
  }
  return outcome(await spawned(path.join(root, file), [...flags, ...more, '--no-build', '--out', out, ...screens], env), out)
}

/** Where an approved picture lives. */
export const picture = (baselines, screen, size) => path.join(baselines, screen, size)

/** The element map recorded next to an approved picture: `[{ locator, box, text, … }]`. */
export const elementsOf = (pictureDir) => JSON.parse(fs.readFileSync(path.join(pictureDir, 'baseline.map.json'), 'utf8')).elements

/** What a pair's report says changed, element by element: `[{ locator, evidence, regions, … }]`. */
export const changed = (pair) => pair?.locators?.changedLocators ?? []

/** The elements a pair's report names as changed. */
export const named = (pair) => changed(pair).map((l) => l.locator)

/** One line per pair, for an assertion message that says what the check saw. */
export const seen = (pairs) =>
  pairs.map((p) => `${p.target ?? p.name}/${p.viewport?.name ?? '-'} ${p.status} ${JSON.stringify(p.summary?.counts ?? p.error ?? p.failReasons)}`).join('\n')
