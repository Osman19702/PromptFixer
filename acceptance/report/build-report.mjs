#!/usr/bin/env node
/**
 * Builds the acceptance results report: results.json (from json-reporter.mjs)
 * joined with the Gherkin scenarios, rendered to HTML and printed to PDF with
 * Playwright's Chromium.
 *
 *   node acceptance/report/build-report.mjs [results.json] [out.pdf]
 */

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

import { readScenarios } from '../support/features.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')
const resultsPath = process.argv[2] || path.join(here, 'out', 'results.json')
const pdfPath = process.argv[3] || path.join(root, 'docs', 'ATDD-RESULTS.pdf')
const htmlPath = path.join(here, 'out', 'ATDD-RESULTS.html')

const { generatedAt, results } = JSON.parse(fs.readFileSync(resultsPath, 'utf8'))
const findings = JSON.parse(fs.readFileSync(path.join(here, 'findings.json'), 'utf8'))
const scenarios = readScenarios()
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const byId = new Map()
for (const r of results) {
  const m = r.name.match(/^([A-L]\d+) — /)
  if (m) byId.set(m[1], r)
}

const git = (cmd) => {
  try {
    return execSync(`git ${cmd}`, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return 'n/a'
  }
}
const installer = (() => {
  const dir = path.join(process.env.LOCALAPPDATA || '', 'PromptFixer', 'release')
  try {
    const exe = fs.readdirSync(dir).find((f) => /^PromptFixer-.*\.exe$/.test(f))
    if (!exe) return null
    const st = fs.statSync(path.join(dir, exe))
    return { file: exe, mb: Math.round(st.size / 1e6), builtAt: st.mtime.toISOString() }
  } catch {
    return null
  }
})()

const rows = scenarios.map((s) => ({ ...s, result: byId.get(s.id) || { status: 'missing' } }))
const groups = [...new Set(rows.map((r) => r.feature))].map((feature) => ({ feature, rows: rows.filter((r) => r.feature === feature) }))
const count = (list, status) => list.filter((r) => r.result.status === status).length
const totals = {
  scenarios: rows.length,
  pass: count(rows, 'pass'),
  fail: count(rows, 'fail'),
  todo: count(rows, 'todo'),
  missing: count(rows, 'missing'),
  durationMs: results.reduce((s, r) => s + (r.durationMs || 0), 0),
}
const verdict = totals.fail || totals.missing ? 'FAIL' : 'PASS'

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const badge = (status) => `<span class="badge ${status}">${{ pass: 'PASS', fail: 'FAIL', todo: 'PENDING', missing: 'NO TEST', skip: 'SKIPPED' }[status] || status}</span>`
const seam = (tags) => tags.map((t) => t.replace('@', '')).join(', ')
const ms = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`)
const step = (s) => s.replace(/^(Given|When|Then|And|But)\b/, '<b>$1</b>')

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>PromptFixer — Acceptance test results</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  body { font: 10.5pt/1.45 "Segoe UI", system-ui, sans-serif; color: #1a1d23; margin: 0; }
  h1 { font-size: 24pt; margin: 0 0 4pt; }
  h2 { font-size: 15pt; margin: 22pt 0 8pt; border-bottom: 1.5px solid #1a1d23; padding-bottom: 3pt; page-break-after: avoid; }
  h3 { font-size: 12pt; margin: 16pt 0 6pt; page-break-after: avoid; }
  .muted { color: #5c6470; }
  .cover { padding-top: 60mm; page-break-after: always; }
  .cover .verdict { display: inline-block; margin-top: 18pt; padding: 8pt 16pt; border-radius: 6pt; font-size: 20pt; font-weight: 700; color: #fff; }
  .verdict.PASS { background: #1f8a4c; } .verdict.FAIL { background: #c0392b; }
  .cards { display: flex; gap: 10pt; margin: 10pt 0 14pt; }
  .card { flex: 1; border: 1px solid #d5d9e0; border-radius: 6pt; padding: 8pt 10pt; }
  .card .n { font-size: 20pt; font-weight: 700; } .card .l { color: #5c6470; font-size: 9pt; }
  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; page-break-inside: auto; }
  th, td { text-align: left; vertical-align: top; padding: 4pt 6pt; border-bottom: 1px solid #e3e6eb; }
  th { background: #f1f3f6; font-weight: 600; }
  tr { page-break-inside: avoid; }
  .badge { display: inline-block; padding: 1pt 6pt; border-radius: 4pt; font-size: 8.5pt; font-weight: 700; color: #fff; white-space: nowrap; }
  .badge.pass { background: #1f8a4c; } .badge.fail { background: #c0392b; } .badge.todo { background: #b7791f; } .badge.missing, .badge.skip { background: #6c757d; }
  .id { font-family: Consolas, monospace; font-weight: 600; white-space: nowrap; }
  .steps { margin: 2pt 0 0; padding-left: 12pt; color: #3a4048; font-size: 9pt; }
  .steps li { margin: 0; }
  .error { font-family: Consolas, monospace; font-size: 8.5pt; white-space: pre-wrap; background: #fdf1f0; border-left: 3px solid #c0392b; padding: 4pt 6pt; margin-top: 4pt; }
  .note { font-size: 9pt; color: #6b5510; }
  .defect { border: 1px solid #d5d9e0; border-left: 4px solid #c0392b; border-radius: 4pt; padding: 8pt 10pt; margin: 8pt 0; page-break-inside: avoid; }
  .defect.fixed { border-left-color: #1f8a4c; }
  .defect h4 { margin: 0 0 3pt; font-size: 11pt; }
  .story { font-style: italic; color: #5c6470; margin: 0 0 6pt; }
  ul.plain { padding-left: 14pt; }
  .env td:first-child { font-weight: 600; width: 32%; }
</style></head><body>

<div class="cover">
  <div class="muted">PromptFixer · Acceptance test-driven development</div>
  <h1>Acceptance test results</h1>
  <div class="muted">Run ${esc(generatedAt.replace('T', ' ').slice(0, 19))} UTC · commit ${esc(git('rev-parse --short HEAD'))} (${esc(git('rev-parse --abbrev-ref HEAD'))}) · v${esc(pkg.version)}</div>
  <div class="verdict ${verdict}">${verdict}</div>
  <div class="cards">
    <div class="card"><div class="n">${totals.scenarios}</div><div class="l">scenarios (acceptance criteria)</div></div>
    <div class="card"><div class="n">${totals.pass}</div><div class="l">passed</div></div>
    <div class="card"><div class="n">${totals.fail}</div><div class="l">failed</div></div>
    <div class="card"><div class="n">${totals.todo}</div><div class="l">pending, with a stated reason</div></div>
  </div>
  <p class="muted">Every scenario below is a Gherkin acceptance criterion in <code>acceptance/features/</code>, executed by a same-named
  automated test in <code>acceptance/</code>. Pending scenarios are registered as tests so they appear in every run and cannot be forgotten.</p>
</div>

<h2>1. Summary by capability</h2>
<table>
  <tr><th>Capability group</th><th>Scenarios</th><th>Passed</th><th>Failed</th><th>Pending</th><th>Seams</th></tr>
  ${groups
    .map(
      (g) =>
        `<tr><td>${esc(g.feature)}</td><td>${g.rows.length}</td><td>${count(g.rows, 'pass')}</td><td>${count(g.rows, 'fail')}</td><td>${count(g.rows, 'todo')}</td><td class="muted">${esc([...new Set(g.rows.flatMap((r) => r.tags))].map((t) => t.replace('@', '')).join(', '))}</td></tr>`
    )
    .join('\n')}
  <tr><th>Total</th><th>${totals.scenarios}</th><th>${totals.pass}</th><th>${totals.fail}</th><th>${totals.todo}</th><th class="muted">${ms(totals.durationMs)} of test time</th></tr>
</table>

<h2>2. Defects found by the scenarios</h2>
${findings.defects
  .map(
    (d) => `<div class="defect ${d.status}"><h4>${esc(d.scenario)} — ${esc(d.title)} <span class="badge ${d.status === 'fixed' ? 'pass' : 'fail'}">${esc(d.status.toUpperCase())}</span></h4>
  <div>${esc(d.detail)}</div><div class="muted" style="margin-top:3pt"><b>Fix:</b> ${esc(d.fix)}</div></div>`
  )
  .join('\n')}
<h3>Observations not acted on</h3>
<ul class="plain">${findings.observations.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>

<h2>3. Environment</h2>
<table class="env">
  <tr><td>Operating system</td><td>${esc(os.type())} ${esc(os.release())} (${esc(os.arch())})</td></tr>
  <tr><td>Node.js</td><td>${esc(process.version)}</td></tr>
  <tr><td>Playwright / Chromium</td><td>${esc(pkg.devDependencies?.playwright || '')} / ${esc(chromiumVersion())}</td></tr>
  <tr><td>Electron</td><td>${esc(pkg.devDependencies?.electron || '')}</td></tr>
  <tr><td>Model provider under test</td><td>Scripted OpenAI-compatible stub (no key, no model file); the local model tier is nightly on the GPU machine</td></tr>
  <tr><td>Packaged installer</td><td>${installer ? `${esc(installer.file)} · ${installer.mb} MB · built ${esc(installer.builtAt.replace('T', ' ').slice(0, 19))} UTC · %LOCALAPPDATA%\\PromptFixer\\release` : 'not built in this run'}</td></tr>
  <tr><td>Isolation</td><td>Each test file boots its own server on an OS-assigned port with private data and model directories</td></tr>
</table>

<h2>4. Results by acceptance criterion</h2>
${groups
  .map(
    (g) => `<h3>${esc(g.feature)}</h3>
<p class="story">${esc(g.rows[0].story)}</p>
<table>
  <tr><th style="width:8%">ID</th><th style="width:52%">Scenario and acceptance criteria</th><th style="width:12%">Seam</th><th style="width:12%">Result</th><th style="width:16%">Time / note</th></tr>
  ${g.rows
    .map(
      (r) => `<tr><td class="id">${esc(r.id)}</td>
    <td><b>${esc(r.title)}</b><ul class="steps">${r.steps.map((s) => `<li>${step(esc(s))}</li>`).join('')}</ul>${r.result.error ? `<div class="error">${esc(r.result.error)}</div>` : ''}</td>
    <td class="muted">${esc(seam(r.tags))}</td>
    <td>${badge(r.result.status)}</td>
    <td class="muted">${r.result.status === 'pass' || r.result.status === 'fail' ? ms(r.result.durationMs) : ''}${r.result.note ? `<div class="note">${esc(r.result.note)}</div>` : ''}</td></tr>`
    )
    .join('\n')}
</table>`
  )
  .join('\n')}

<p class="muted" style="margin-top:20pt">Generated by <code>npm run test:report</code> from <code>${esc(path.relative(root, resultsPath))}</code>. Strategy: <code>docs/ATDD.md</code>. Narrative report: <code>docs/ATDD-REPORT.md</code>.</p>
</body></html>`

function chromiumVersion() {
  try {
    return execSync('npx playwright --version', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().replace(/^Version\s*/, '')
  } catch {
    return ''
  }
}

fs.mkdirSync(path.dirname(htmlPath), { recursive: true })
fs.writeFileSync(htmlPath, html)
const browser = await chromium.launch()
const page = await browser.newPage()
await page.setContent(html, { waitUntil: 'load' })
await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' } })
await browser.close()
console.log(`Report: ${verdict} · ${totals.pass} pass · ${totals.fail} fail · ${totals.todo} pending → ${pdfPath}`)
