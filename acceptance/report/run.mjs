#!/usr/bin/env node
/**
 * `npm run test:report`: run the acceptance suite with the JSON reporter
 * (and the usual spec output), then build the PDF whatever the outcome —
 * a failing run is exactly when the report matters. Exits with the test
 * runner's code.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')
const out = path.join(here, 'out')
fs.mkdirSync(out, { recursive: true })
const results = path.join(out, 'results.json')

const run = spawnSync(
  process.execPath,
  [
    '--test',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    // An absolute Windows path is not a valid module specifier; a file URL is.
    `--test-reporter=${pathToFileURL(path.join(here, 'json-reporter.mjs')).href}`,
    `--test-reporter-destination=${results}`,
    ...fs
      .readdirSync(path.join(root, 'acceptance'))
      .filter((f) => f.endsWith('.acceptance.test.js'))
      .map((f) => path.join(root, 'acceptance', f)),
  ],
  { cwd: root, stdio: 'inherit' }
)

const report = spawnSync(process.execPath, [path.join(here, 'build-report.mjs'), results], { cwd: root, stdio: 'inherit' })
process.exit(run.status || report.status || 0)
