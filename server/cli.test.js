/**
 * Tests for the CI prompt linter (scripts/lint-prompts.js).
 * Spawns the CLI with node on temp files, the way a CI job would.
 * Run with: npm test
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(__dirname, '..', 'scripts', 'lint-prompts.js')

let dir

/** Scores in the mid-90s with no high or medium findings. */
const GOOD = `You are a senior content strategist at a small calendar-software company.

## Task
Write one blog post announcing our new shared booking page feature for the company blog.

## Context
Our product is a calendar app for small agencies. The new feature lets a whole team share a single booking page so clients can pick any free slot.

## Requirements
- At most 600 words
- Audience: non-technical agency owners who already use our product
- Do not include statistics unless they appear in the source notes below
- Explain the benefit before the mechanics

## Output format
Markdown, with an H1 title and three H2 sections.

## Source notes
"""
Launch date: 14 October. Works with Google and Outlook calendars.
"""
`

/** Two words: a high-severity "very short" finding and a score of about 50. */
const VAGUE = 'fix this\n'

/** Scores in the low 80s with only medium and low findings, so it clears the default bar but not 95. */
const DECENT =
  'Refactor the parse function in utils.py so it handles empty input and raises ValueError on malformed rows, then add pytest unit tests for the edge cases. Return only the changed function and the new test file.\n'

/** Exactly 11 words: one under the "very short" threshold, so any leaked comment text would hide that finding. */
const ELEVEN_WORDS = 'Write a haiku about autumn leaves falling in a quiet park\n'

const INTENT_CODE = '<!-- promptfixer: intent=code -->\n'

function write(rel, content) {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

/** Runs the CLI from inside the temp dir so reported paths are short and relative. */
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptfixer-cli-'))
})

after(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a good prompt passes with exit 0', async () => {
  write('good.md', GOOD)
  const { code, stdout, stderr } = await run(['good.md'])
  assert.equal(code, 0, stderr)
  assert.match(stdout, /^PASS  good\.md  score +\d+  high 0  medium 0/m)
  assert.match(stdout, /^1 file, 1 passed, 0 failed \(min score 0, fail on high\)$/m)
})

test('a vague prompt fails --fail-on high with exit 1 and the file is named', async () => {
  write('vague.md', VAGUE)
  const { code, stdout } = await run(['vague.md', '--fail-on', 'high'])
  assert.equal(code, 1)
  assert.match(stdout, /^FAIL  vague\.md  score +\d+  high [1-9]/m)
  assert.match(stdout, /top: Prompt is very short/)
  assert.match(stdout, /^1 file, 0 passed, 1 failed/m)

  // The same file clears the bar once severity gating is switched off.
  const relaxed = await run(['vague.md', '--fail-on', 'none'])
  assert.equal(relaxed.code, 0, relaxed.stdout)
})

test('--min-score 95 fails a decent prompt that has no high findings', async () => {
  write('decent.md', DECENT)
  const lenient = await run(['decent.md'])
  assert.equal(lenient.code, 0, lenient.stdout)
  assert.match(lenient.stdout, /^PASS  decent\.md  score +[78]\d  high 0/m)

  const strict = await run(['decent.md', '--min-score', '95'])
  assert.equal(strict.code, 1)
  assert.match(strict.stdout, /^FAIL  decent\.md/m)
  assert.match(strict.stdout, /1 file, 0 passed, 1 failed \(min score 95, fail on high\)/)
})

test('--json prints one parseable object with the documented shape and nothing else', async () => {
  write('good.md', GOOD)
  write('vague.md', VAGUE)
  const { code, stdout } = await run(['good.md', 'vague.md', '--json', '--min-score', '70'])
  assert.equal(code, 1)

  const report = JSON.parse(stdout)
  assert.deepEqual(Object.keys(report), ['files', 'summary'])
  assert.deepEqual(report.summary, { files: 2, passed: 1, failed: 1, minScore: 70, failOn: 'high' })
  assert.equal(report.files.length, 2)
  for (const file of report.files) {
    assert.deepEqual(Object.keys(file), ['path', 'intent', 'score', 'categories', 'issues', 'passed'])
    assert.equal(typeof file.score, 'number')
    assert.deepEqual(Object.keys(file.categories).sort(), ['clarity', 'context', 'format', 'specificity', 'structure'])
    assert.ok(Array.isArray(file.issues))
    for (const issue of file.issues) {
      assert.ok(issue.id && issue.title && issue.category, JSON.stringify(issue))
      assert.ok(['high', 'medium', 'low'].includes(issue.severity), issue.severity)
    }
  }
  const good = report.files.find((f) => f.path === 'good.md')
  const vague = report.files.find((f) => f.path === 'vague.md')
  assert.equal(good.intent, 'general')
  assert.equal(good.passed, true)
  assert.equal(vague.passed, false)
  assert.ok(vague.issues.some((i) => i.id === 'too-short'))
})

test('directories are searched recursively for .md, .txt and .prompt, ignoring other files', async () => {
  write('tree/a.md', GOOD)
  write('tree/nested/b.txt', GOOD)
  write('tree/nested/deep/c.prompt', GOOD)
  // Both of these would fail the lint if they were picked up.
  write('tree/nested/deep/skip.js', VAGUE)
  write('tree/notes.json', VAGUE)

  const { code, stdout } = await run(['tree', '--json'])
  assert.equal(code, 0, stdout)
  const report = JSON.parse(stdout)
  assert.deepEqual(
    report.files.map((f) => f.path),
    ['tree/a.md', 'tree/nested/b.txt', 'tree/nested/deep/c.prompt']
  )
  assert.equal(report.summary.files, 3)
})

test('a first-line intent comment sets the intent and is stripped before linting', async () => {
  write('intent/code.md', INTENT_CODE + DECENT)
  write('intent/plain.md', DECENT)
  write('intent/eleven.md', INTENT_CODE + ELEVEN_WORDS)

  const { code, stdout } = await run(['intent', '--json', '--fail-on', 'none'])
  assert.equal(code, 0, stdout)
  const byPath = Object.fromEntries(JSON.parse(stdout).files.map((f) => [f.path, f]))

  const asCode = byPath['intent/code.md']
  const asText = byPath['intent/plain.md']
  assert.equal(asCode.intent, 'code')
  assert.equal(asText.intent, 'general')
  // Linted as code: the audience rule is skipped for code prompts, so its presence
  // under 'general' and absence under 'code' proves the comment was honoured.
  assert.equal(asCode.issues.find((i) => i.id === 'no-audience'), undefined)
  assert.equal(asText.issues.find((i) => i.id === 'no-audience')?.severity, 'low')
  // "Return only the changed function" is a scope bound, so no limit nag either way.
  assert.equal(asCode.issues.find((i) => i.id === 'no-limits'), undefined)
  assert.equal(asText.issues.find((i) => i.id === 'no-limits'), undefined)

  // The comment is not part of the prompt: 11 words plus the comment still trips the under-12-words rule.
  const eleven = byPath['intent/eleven.md']
  assert.equal(eleven.intent, 'code')
  assert.ok(
    eleven.issues.some((i) => i.id === 'too-short'),
    `expected too-short, got ${eleven.issues.map((i) => i.id).join(', ')}`
  )

  // --intent is only the default for files without a comment.
  const forced = await run(['intent', '--json', '--fail-on', 'none', '--intent', 'writing'])
  const forcedByPath = Object.fromEntries(JSON.parse(forced.stdout).files.map((f) => [f.path, f]))
  assert.equal(forcedByPath['intent/code.md'].intent, 'code')
  assert.equal(forcedByPath['intent/plain.md'].intent, 'writing')
})

test('--quiet prints only the summary line', async () => {
  write('good.md', GOOD)
  write('vague.md', VAGUE)
  const { code, stdout } = await run(['good.md', 'vague.md', '--quiet'])
  assert.equal(code, 1)
  assert.equal(stdout.trim().split('\n').length, 1)
  assert.match(stdout, /^2 files, 1 passed, 1 failed \(min score 0, fail on high\)$/m)
})

test('no paths, unknown flags, unknown intents and missing paths exit 2 with usage on stderr', async () => {
  write('good.md', GOOD)

  const none = await run([])
  assert.equal(none.code, 2)
  assert.equal(none.stdout, '')
  assert.match(none.stderr, /no paths given/)
  assert.match(none.stderr, /^Usage: node scripts\/lint-prompts\.js <path\.\.\.>/m)

  const bad = [
    ['good.md', '--bogus'],
    ['good.md', '--intent', 'poetry'],
    ['good.md', '--fail-on', 'severe'],
    ['good.md', '--min-score', '101'],
    ['missing.md'],
  ]
  for (const args of bad) {
    const { code, stderr } = await run(args)
    assert.equal(code, 2, args.join(' '))
    assert.match(stderr, /Usage:/, args.join(' '))
  }
})
