#!/usr/bin/env node
/**
 * Write SHA256SUMS.txt for the release artifacts, in `sha256sum` format
 * (`<hex>  <filename>`, lowercase, two spaces, LF) so `sha256sum -c` accepts it.
 *
 *   npm run release:checksums                  hash release/PromptFixer-* into release/SHA256SUMS.txt
 *   npm run release:checksums -- --dir <dir>   another folder (e.g. %LOCALAPPDATA%\PromptFixer\release)
 *   npm run release:checksums -- --check       verify SHA256SUMS.txt; exit 1 on any mismatch or missing file
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SUMS_FILE = 'SHA256SUMS.txt'
const ARTIFACT = /^PromptFixer-.*\.(exe|blockmap|dmg|AppImage)$/

export async function sha256File(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export async function writeSums(dir, names) {
  const files = (names ?? (await fs.readdir(dir)).filter((n) => ARTIFACT.test(n))).sort()
  if (files.length === 0) throw new Error(`no release artifacts in ${dir}`)
  const lines = []
  for (const name of files) lines.push(`${await sha256File(path.join(dir, name))}  ${name}`)
  const text = lines.join('\n') + '\n'
  await fs.writeFile(path.join(dir, SUMS_FILE), text, 'utf8')
  return text
}

export async function checkSums(dir) {
  const text = await fs.readFile(path.join(dir, SUMS_FILE), 'utf8')
  const failures = []
  for (const line of text.split('\n').filter(Boolean)) {
    const m = /^([0-9a-f]{64})  (.+)$/.exec(line)
    if (!m) {
      failures.push(`malformed line: ${line}`)
      continue
    }
    const actual = await sha256File(path.join(dir, m[2])).catch(() => null)
    if (actual !== m[1]) failures.push(`${m[2]}: ${actual ? 'FAILED' : 'missing'}`)
  }
  return failures
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const dirIdx = args.indexOf('--dir')
  const dir = path.resolve(dirIdx >= 0 ? args[dirIdx + 1] : 'release')
  if (args.includes('--check')) {
    const failures = await checkSums(dir)
    for (const f of failures) console.error(f)
    console.log(failures.length ? `${failures.length} problem(s)` : `${SUMS_FILE}: OK`)
    process.exit(failures.length ? 1 : 0)
  } else {
    process.stdout.write(await writeSums(dir))
  }
}
