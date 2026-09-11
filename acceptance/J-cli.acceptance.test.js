/**
 * Group J — The CI linter.
 * Scenarios: acceptance/features/J-cli.feature. Run: npm run test:acceptance
 *
 * The CLI is spawned the way a CI job runs it, on files in a temp directory.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'

import { startApp } from './support/app.js'
import { BLOG_PROMPT, CODE_PROMPT, GOOD_PROMPT } from './support/fixtures.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(__dirname, '..', 'scripts', 'lint-prompts.js')

let dir
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptfixer-acc-cli-'))
})
after(() => fs.rmSync(dir, { recursive: true, force: true }))

const write = (rel, content) => {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

/** Runs from inside the temp dir, with no network and no server, like CI. */
const run = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: dir,
      env: { ...process.env, PROMPTFIXER_DATA_DIR: dir, PROMPTFIXER_MODEL_DIR: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })

test('J1 — A team can gate its prompts in CI with no server, no model and no key', async () => {
  write('prompts/good.md', `${GOOD_PROMPT}\n`)
  const pass = await run(['prompts', '--min-score', '70', '--fail-on', 'high'])
  assert.equal(pass.code, 0, pass.stdout + pass.stderr)

  write('prompts/vague.md', 'fix this\n')
  const fail = await run(['prompts', '--min-score', '70', '--fail-on', 'high'])
  assert.equal(fail.code, 1)
  assert.match(fail.stdout, /vague\.md/, 'the offending file is named')
  assert.match(fail.stdout, /short|verb/i, 'and what is wrong with it')
  fs.rmSync(path.join(dir, 'prompts'), { recursive: true })
})

test('J2 — The gate uses the same rules as the app', async () => {
  const app = await startApp()
  try {
    write('same.md', `<!-- promptfixer: intent=code -->\n${CODE_PROMPT}\n`)
    const { stdout } = await run(['same.md', '--json'])
    const cli = JSON.parse(stdout).files[0]
    const api = (await app.analyze(CODE_PROMPT, { intent: 'code' })).body.analysis
    assert.equal(cli.intent, 'code')
    assert.equal(cli.score, api.score)
    assert.deepEqual(cli.categories, api.categories)
    assert.deepEqual(
      cli.issues.map((i) => `${i.id}/${i.severity}`),
      api.issues.map((i) => `${i.id}/${i.severity}`)
    )
  } finally {
    await app.stop()
  }
})

test('J3 — Directories are searched the way the documentation says', async () => {
  write('tree/a.md', `${GOOD_PROMPT}\n`)
  write('tree/deep/b.txt', `${GOOD_PROMPT}\n`)
  write('tree/deep/deeper/c.prompt', `${GOOD_PROMPT}\n`)
  write('tree/ignored.json', '{"not": "a prompt"}')
  write('tree/ignored.js', 'console.log(1)')
  write('tree/README', 'plain file without extension')
  const { code, stdout } = await run(['tree', '--json'])
  assert.equal(code, 0)
  const paths = JSON.parse(stdout)
    .files.map((f) => f.path.replace(/\\/g, '/'))
    .sort()
  assert.deepEqual(paths, ['tree/a.md', 'tree/deep/b.txt', 'tree/deep/deeper/c.prompt'])
})

test('J4 — A file can declare its own task type', async () => {
  write('declared.md', `<!-- promptfixer: intent=code -->\n${CODE_PROMPT}\n`)
  write('undeclared.md', `${CODE_PROMPT}\n`)
  const declared = JSON.parse((await run(['declared.md', '--json'])).stdout).files[0]
  const undeclared = JSON.parse((await run(['undeclared.md', '--json', '--intent', 'code'])).stdout).files[0]
  assert.equal(declared.intent, 'code')
  assert.equal(undeclared.intent, 'code', '--intent is the default for files without a comment')
  assert.equal(declared.score, undeclared.score, 'the comment itself does not affect the score')
  const general = JSON.parse((await run(['undeclared.md', '--json'])).stdout).files[0]
  assert.equal(general.intent, 'general')
})

test('J5 — Machine-readable output is machine-readable', async () => {
  write('one.md', `${BLOG_PROMPT}\n`)
  const json = await run(['one.md', '--json'])
  const report = JSON.parse(json.stdout) // throws if anything else is on stdout
  assert.deepEqual(Object.keys(report), ['files', 'summary'])
  assert.deepEqual(Object.keys(report.files[0]), ['path', 'intent', 'score', 'categories', 'issues', 'passed'])
  assert.ok(report.files[0].issues.length > 0)

  const quiet = await run(['one.md', '--quiet'])
  assert.equal(quiet.stdout.trim().split('\n').length, 1, 'only the summary line')
})

test('J6 — A misconfigured job is distinguishable from failing prompts', async () => {
  write('ok.md', `${GOOD_PROMPT}\n`)
  for (const args of [[], ['ok.md', '--bogus'], ['ok.md', '--intent', 'poetry'], ['nope.md']]) {
    const r = await run(args)
    assert.equal(r.code, 2, `${args.join(' ') || '(no args)'} exited ${r.code}`)
    assert.match(r.stderr, /usage/i, 'usage on stderr')
  }
  write('bad.md', 'fix this\n')
  assert.equal((await run(['bad.md'])).code, 1, 'a genuine quality failure is exit 1')
})
