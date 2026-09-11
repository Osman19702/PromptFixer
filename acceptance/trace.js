#!/usr/bin/env node
/**
 * Traceability: every scenario in acceptance/features/*.feature against the
 * automated tests in acceptance/*.acceptance.test.js, matched by the
 * "A1 — Title" identifier both carry. Prints a markdown table and exits
 * non-zero if a scenario has no test at all (a todo counts as a test — the
 * point is that no scenario can be silently forgotten).
 *
 * Run: npm run test:trace
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { readScenarios } from './support/features.js'

const dir = path.dirname(fileURLToPath(import.meta.url))

/** id → { file, todo } for every top-level test in the acceptance files. */
export function readTests() {
  const tests = new Map()
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.acceptance.test.js'))) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8')
    // `{ todo: 'reason' }` or `{ todo: REASON }` where REASON is a const in the same file.
    const consts = Object.fromEntries([...src.matchAll(/const\s+([A-Z_]+)\s*=\s*(['"`])(.*?)\2/g)].map((m) => [m[1], m[3]]))
    for (const m of src.matchAll(/test\(\s*(['"`])([A-L]\d+) — .*?\1\s*(?:,\s*\{\s*todo:\s*(?:(['"`])(.*?)\3|([A-Z_]+))\s*\})?/gs)) {
      const todo = m[4] ?? (m[5] ? consts[m[5]] || m[5] : null)
      tests.set(m[2], { file, todo })
    }
  }
  return tests
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const scenarios = readScenarios()
  const tests = readTests()
  const rows = scenarios.map((s) => {
    const t = tests.get(s.id)
    const status = !t ? 'MISSING' : t.todo ? 'todo' : 'automated'
    return { ...s, status, note: t?.todo || '' }
  })
  const counts = { automated: 0, todo: 0, MISSING: 0 }
  for (const r of rows) counts[r.status]++

  let current = ''
  console.log('| ID | Scenario | Seam | Status |')
  console.log('|---|---|---|---|')
  for (const r of rows) {
    if (r.feature !== current) {
      current = r.feature
      console.log(`| **${current}** | | | |`)
    }
    const seam = r.tags.map((t) => t.replace('@', '')).join(', ')
    const status = r.status === 'automated' ? '✅ automated' : r.status === 'todo' ? `⏳ ${r.note}` : '❌ no test'
    console.log(`| ${r.id} | ${r.title} | ${seam} | ${status} |`)
  }
  console.log()
  console.log(`Scenarios: ${rows.length} · automated: ${counts.automated} · todo: ${counts.todo} · missing: ${counts.MISSING}`)
  if (counts.MISSING) process.exit(1)
}
