#!/usr/bin/env node
/**
 * CI-friendly prompt linter.
 *
 * Runs the same deterministic rules the app uses (server/analyze.js) over a
 * set of prompt files and exits non-zero when one falls below the bar, so a
 * prompts/ directory can be gated in CI with no server, model or API key.
 *
 *   node scripts/lint-prompts.js <path...> [--intent <id>] [--min-score <n>]
 *     [--fail-on high|medium|low|none] [--json] [--quiet]
 */

import fs from 'node:fs'
import path from 'node:path'
import { analyzePrompt } from '../server/analyze.js'

const INTENTS = ['general', 'code', 'writing', 'analysis', 'agent', 'extraction', 'image']
const FAIL_ON = ['high', 'medium', 'low', 'none']
const SEVERITY_RANK = { high: 0, medium: 1, low: 2 }
const PROMPT_EXTENSIONS = new Set(['.md', '.txt', '.prompt'])
const SKIP_DIRS = new Set(['node_modules'])
// First-line directive, e.g. `<!-- promptfixer: intent=code -->`, stripped before linting.
const INTENT_COMMENT = /^[ \t]*<!--\s*promptfixer:\s*intent\s*=\s*([\w-]+)\s*-->[ \t]*(?:\r?\n|$)/i

const USAGE = `Usage: node scripts/lint-prompts.js <path...> [--intent <id>] [--min-score <n>] [--fail-on high|medium|low|none] [--json] [--quiet]

Lints each prompt file with PromptFixer's deterministic rules (no server, no model).
Directories are searched recursively for *.md, *.txt and *.prompt files
(node_modules and dot-directories are skipped). Each file is one prompt.

A file may set its own intent with a first-line comment, stripped before linting:
  <!-- promptfixer: intent=code -->

Options:
  --intent <id>      Intent for files without a comment: ${INTENTS.join(', ')} (default: general)
  --min-score <n>    Fail any file scoring below n, 0-100 (default: 0)
  --fail-on <sev>    Fail any file with an issue at or above this severity:
                     high, medium, low, or none to disable (default: high)
  --json             Print one JSON object with every file's result and nothing else
  --quiet            Print only the summary line
  -h, --help         Show this help

Exit codes:
  0  every file passed
  1  at least one file scored below --min-score or has an issue at or above --fail-on
  2  usage error (no paths, unknown flag, unknown intent, path not found, no prompt files)`

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { paths: [], intent: 'general', minScore: '0', failOn: 'high', json: false, quiet: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      opts.paths.push(...argv.slice(i + 1))
      break
    }
    if (!arg.startsWith('-') || arg === '-') {
      opts.paths.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const flag = eq === -1 ? arg : arg.slice(0, eq)
    const value = () => {
      if (eq !== -1) return arg.slice(eq + 1)
      if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) throw new UsageError(`${flag} needs a value`)
      return argv[++i]
    }
    const bare = () => {
      if (eq !== -1) throw new UsageError(`${flag} does not take a value`)
      return true
    }
    switch (flag) {
      case '--intent':
        opts.intent = value()
        break
      case '--min-score':
        opts.minScore = value()
        break
      case '--fail-on':
        opts.failOn = value()
        break
      case '--json':
        opts.json = bare()
        break
      case '--quiet':
      case '-q':
        opts.quiet = bare()
        break
      case '--help':
      case '-h':
        opts.help = bare()
        break
      default:
        throw new UsageError(`unknown flag: ${arg}`)
    }
  }
  if (opts.help) return opts

  if (!INTENTS.includes(opts.intent)) {
    throw new UsageError(`unknown intent: ${opts.intent} (expected one of ${INTENTS.join(', ')})`)
  }
  if (!/^\d+$/.test(opts.minScore) || Number(opts.minScore) > 100) {
    throw new UsageError(`--min-score must be an integer from 0 to 100, got: ${opts.minScore}`)
  }
  opts.minScore = Number(opts.minScore)
  if (!FAIL_ON.includes(opts.failOn)) {
    throw new UsageError(`--fail-on must be one of ${FAIL_ON.join(', ')}, got: ${opts.failOn}`)
  }
  if (opts.paths.length === 0) throw new UsageError('no paths given')
  return opts
}

/** Relative to cwd with forward slashes when inside it, else absolute — stable across CI runners. */
function displayPath(file) {
  const rel = path.relative(process.cwd(), file)
  const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel)
  return (inside ? rel : file).split(path.sep).join('/')
}

function walk(dir, out) {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      walk(full, out)
    } else if (entry.isFile() && PROMPT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push(full)
    }
  }
}

function collectFiles(inputs) {
  const files = []
  for (const input of inputs) {
    const abs = path.resolve(input)
    let stat
    try {
      stat = fs.statSync(abs)
    } catch {
      throw new UsageError(`path not found: ${input}`)
    }
    // A file named explicitly is linted whatever its extension; only directory
    // walks filter by extension.
    if (stat.isDirectory()) walk(abs, files)
    else files.push(abs)
  }
  const unique = [...new Set(files)]
  if (unique.length === 0) {
    throw new UsageError(`no prompt files (*.md, *.txt, *.prompt) found under: ${inputs.join(', ')}`)
  }
  return unique
}

function lintFile(file, defaultIntent) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    throw new UsageError(`cannot read ${displayPath(file)}: ${err.message}`)
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  let intent = defaultIntent
  const directive = text.match(INTENT_COMMENT)
  if (directive) {
    intent = directive[1].toLowerCase()
    if (!INTENTS.includes(intent)) {
      throw new UsageError(`${displayPath(file)}: unknown intent in promptfixer comment: ${directive[1]}`)
    }
    text = text.slice(directive[0].length)
  }

  const result = analyzePrompt(text, { intent })
  return { path: displayPath(file), intent, score: result.score, categories: result.categories, issues: result.issues }
}

function passes(entry, { minScore, failOn }) {
  if (entry.score < minScore) return false
  if (failOn === 'none') return true
  return !entry.issues.some((issue) => (SEVERITY_RANK[issue.severity] ?? 99) <= SEVERITY_RANK[failOn])
}

function formatLine(entry) {
  const counts = { high: 0, medium: 0, low: 0 }
  for (const issue of entry.issues) if (issue.severity in counts) counts[issue.severity]++
  // Issues arrive sorted by severity, so the first two are the worst two.
  const top = entry.issues.slice(0, 2).map((issue) => issue.title).join('; ')
  return (
    `${entry.passed ? 'PASS' : 'FAIL'}  ${entry.path}  score ${String(entry.score).padStart(3)}` +
    `  high ${counts.high}  medium ${counts.medium}  low ${counts.low}` +
    (top ? `  top: ${top}` : '')
  )
}

function formatSummary(summary) {
  const n = summary.files
  return `${n} file${n === 1 ? '' : 's'}, ${summary.passed} passed, ${summary.failed} failed (min score ${summary.minScore}, fail on ${summary.failOn})`
}

function usageError(message) {
  process.stderr.write(`lint-prompts: ${message}\n\n${USAGE}\n`)
  return 2
}

function main(argv) {
  let opts
  let results
  try {
    opts = parseArgs(argv)
    if (opts.help) {
      process.stdout.write(`${USAGE}\n`)
      return 0
    }
    results = collectFiles(opts.paths).map((file) => {
      const entry = lintFile(file, opts.intent)
      entry.passed = passes(entry, opts)
      return entry
    })
  } catch (err) {
    if (err instanceof UsageError) return usageError(err.message)
    throw err
  }

  const passed = results.filter((r) => r.passed).length
  const summary = {
    files: results.length,
    passed,
    failed: results.length - passed,
    minScore: opts.minScore,
    failOn: opts.failOn,
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ files: results, summary }, null, 2)}\n`)
  } else {
    const lines = opts.quiet ? [] : results.map(formatLine)
    lines.push(formatSummary(summary))
    process.stdout.write(`${lines.join('\n')}\n`)
  }
  return summary.failed > 0 ? 1 : 0
}

// exitCode rather than exit() so piped stdout is flushed before the process ends.
process.exitCode = main(process.argv.slice(2))
