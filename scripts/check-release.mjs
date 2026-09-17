#!/usr/bin/env node
/**
 * The gate a release must pass. The version is written down once, in
 * package.json; everything that repeats it has to agree, and nothing ships
 * without its changelog entry.
 *
 *   npm run check:release                          package.json, package-lock.json, CHANGELOG.md and the sources agree
 *   node scripts/check-release.mjs --tag v0.2.0    the same, the tag is "v" + that version, and [Unreleased] is empty
 *   node scripts/check-release.mjs --root <dir>    check another checkout
 *
 * Prints one line per problem and exits 1, or "release check passed: x.y.z"
 * and exits 0. Usage errors exit 2. The Release workflow runs the --tag form
 * before anything else; docs/RELEASING.md says when to run it by hand.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHANGELOG, LINK_REFERENCE, SECTION_HEADING, changelogSection, fencedLines, hasEntries } from './changelog-section.mjs'

export const USAGE = 'usage: check-release.mjs [--tag v<version>] [--root <dir>]'

// The grammar from semver.org, unchanged.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

export const isSemVer = (version) => typeof version === 'string' && SEMVER.test(version)

/** `npm version` keeps the lock file in step; an edit of package.json by hand does not. */
export function checkLock(version, lock) {
  const problems = []
  const places = [
    ['version', lock?.version],
    ['packages[""].version', lock?.packages?.['']?.version],
  ]
  for (const [where, found] of places) {
    if (found !== version) problems.push(`package-lock.json: ${where} is ${found ?? 'missing'}, package.json says ${version} (run "npm version ${version} --no-git-tag-version")`)
  }
  return problems
}

/** A real calendar day, written YYYY-MM-DD. */
function isDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  const day = new Date(`${text}T00:00:00Z`)
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === text
}

/**
 * What CHANGELOG.md owes a release of `version`. With `tagged`, [Unreleased]
 * must be empty as well: the tagged commit ships everything in the tree, so
 * an entry still sitting there would ship without being in the release notes.
 */
export function checkChangelog(text, version, { tagged = false } = {}) {
  const lines = text.split(/\r?\n/)
  const fenced = fencedLines(lines)
  const headings = []
  const strays = []
  const links = new Map()
  lines.forEach((line, i) => {
    // A heading or a link reference quoted in a code fence is an example.
    if (fenced[i]) return
    const h = SECTION_HEADING.exec(line)
    if (h) headings.push({ name: h[1], rest: h[2].trim(), line: i + 1 })
    else if (line.startsWith('## ')) strays.push({ text: line.trim(), line: i + 1 })
    const l = LINK_REFERENCE.exec(line)
    if (l) links.set(l[1], l[2])
  })

  const unreleased = headings.find((h) => h.name === 'Unreleased')
  const newest = headings.find((h) => h.name !== 'Unreleased')
  const own = headings.find((h) => h.name === version)
  const problems = []

  if (!unreleased) problems.push(`${CHANGELOG} has no "## [Unreleased]" section`)
  // changelog-section.mjs ends a section at any "## " line, so one of these would cut the release notes short.
  for (const stray of strays) problems.push(`${CHANGELOG}:${stray.line}: "${stray.text}" is not a version heading; those are "## [x.y.z] - YYYY-MM-DD", and a heading inside a section is "###"`)
  if (!own) {
    problems.push(`${CHANGELOG} has no section for ${version}: move the entries under [Unreleased] into "## [${version}] - YYYY-MM-DD"`)
    return problems
  }
  if (newest !== own) {
    // Everything below follows from this one, so it is the only line reported.
    problems.push(`${CHANGELOG}: the newest section is [${newest.name}] but package.json says ${version}; they must be the same version (bump with "npm version ${newest.name} --no-git-tag-version", or keep entries that are not released yet under [Unreleased])`)
    return problems
  }
  if (unreleased && unreleased.line > own.line) problems.push(`${CHANGELOG}: [Unreleased] belongs above [${version}] (it is on line ${unreleased.line}, below line ${own.line})`)

  const date = /^- (\S+)$/.exec(own.rest)?.[1]
  if (!date || !isDate(date)) problems.push(`${CHANGELOG}:${own.line}: the [${version}] heading needs its release date: "## [${version}] - YYYY-MM-DD"`)

  if (!hasEntries(changelogSection(text, version))) problems.push(`${CHANGELOG}:${own.line}: the [${version}] section is empty`)

  const link = links.get(version)
  if (!link) problems.push(`${CHANGELOG} has no link reference "[${version}]: ..." at the bottom`)
  else if (!link.endsWith(`v${version}`)) problems.push(`${CHANGELOG}: the [${version}] link must end in v${version}, it is ${link}`)

  const head = links.get('Unreleased')
  if (!head) problems.push(`${CHANGELOG} has no link reference "[Unreleased]: ..." at the bottom`)
  else if (!head.endsWith(`/compare/v${version}...HEAD`)) problems.push(`${CHANGELOG}: the [Unreleased] link must compare v${version}...HEAD, it is ${head}`)

  if (tagged && hasEntries(changelogSection(text, 'Unreleased'))) problems.push(`${CHANGELOG}: [Unreleased] still has entries; a tagged commit ships them, so they belong in [${version}]`)
  return problems
}

const QUOTED_VERSION = /(['"`])\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?\1/g
const HEALTH_ROUTE = /(['"`])\/api\/health\1/

/**
 * Lines of one source file that write a version down instead of reading it:
 * package.json's own version as a quoted literal anywhere, and any quoted
 * x.y.z inside the GET /api/health handler, where a stale number is what
 * people would be shown. Returns `{ line, literal, where }`, 1-based.
 */
export function hardCodedVersions(source, version) {
  const lines = source.split(/\r?\n/)
  // The handler runs from the line naming the route to the line that closes
  // its call. Counting parentheses is enough: no version or route has any.
  const inHealth = new Set()
  const start = lines.findIndex((l) => HEALTH_ROUTE.test(l))
  if (start >= 0) {
    let depth = 0
    for (let i = start; i < lines.length; i++) {
      inHealth.add(i)
      for (const ch of lines[i]) depth += ch === '(' ? 1 : ch === ')' ? -1 : 0
      if (depth <= 0) break
    }
  }
  const found = []
  lines.forEach((text, i) => {
    for (const m of text.matchAll(QUOTED_VERSION)) {
      const literal = m[0].slice(1, -1)
      if (inHealth.has(i)) found.push({ line: i + 1, literal, where: 'the /api/health handler' })
      else if (literal === version) found.push({ line: i + 1, literal, where: 'the source' })
    }
  })
  return found
}

// What electron-builder packs and runs (package.json > build.files), minus the tests.
const SOURCE_DIRS = ['server', 'electron', 'src']
const SOURCE_FILE = /\.(?:js|mjs|cjs|ts|tsx)$/
const NOT_SOURCE = /\.test\.[a-z]+$|\.d\.ts$/

function* sourceFiles(root, dir) {
  let entries
  try {
    entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const rel = `${dir}/${entry.name}`
    // server/data is the browser-mode library, not code.
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && rel !== 'server/data') yield* sourceFiles(root, rel)
    } else if (SOURCE_FILE.test(entry.name) && !NOT_SOURCE.test(entry.name)) yield rel
  }
}

export function checkSources(root, version) {
  const problems = []
  for (const dir of SOURCE_DIRS) {
    for (const rel of sourceFiles(root, dir)) {
      for (const hit of hardCodedVersions(fs.readFileSync(path.join(root, rel), 'utf8'), version)) {
        problems.push(`${rel}:${hit.line}: '${hit.literal}' is written into ${hit.where}; read the version from package.json instead`)
      }
    }
  }
  return problems
}

export function checkTag(tag, version) {
  return tag === `v${version}` ? [] : [`tag ${tag} does not match package.json, which says ${version}: the tag for it is v${version}`]
}

function readJson(root, name, problems) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'))
  } catch (err) {
    problems.push(`${name}: ${err.code === 'ENOENT' ? 'missing' : `cannot be read (${err.message})`}`)
    return null
  }
}

/** Every check against the checkout in `root`. Returns `{ version, problems }`. */
export function checkRelease(root, { tag } = {}) {
  const problems = []
  const pkg = readJson(root, 'package.json', problems)
  if (!pkg) return { version: null, problems }
  const version = pkg.version
  if (!isSemVer(version)) {
    // Nothing else can be compared with a version that is not one.
    problems.push(`package.json: version ${JSON.stringify(version)} is not a Semantic Version (x.y.z)`)
    return { version: null, problems }
  }

  const lock = readJson(root, 'package-lock.json', problems)
  if (lock) problems.push(...checkLock(version, lock))

  let changelog = null
  try {
    changelog = fs.readFileSync(path.join(root, CHANGELOG), 'utf8')
  } catch {
    problems.push(`${CHANGELOG}: missing`)
  }
  if (changelog !== null) problems.push(...checkChangelog(changelog, version, { tagged: tag !== undefined }))

  problems.push(...checkSources(root, version))
  if (tag !== undefined) problems.push(...checkTag(tag, version))
  return { version, problems }
}

/** `{ tag, root }`, or `{ error }` for a command line that makes no sense. */
export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag !== '--tag' && flag !== '--root') return { error: `unknown argument: ${flag}` }
    const value = argv[++i]
    if (!value || value.startsWith('--')) return { error: `${flag} needs a value` }
    out[flag.slice(2)] = value
  }
  return out
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  if (args.error) {
    console.error(`${args.error}\n${USAGE}`)
    process.exit(2)
  }
  const root = path.resolve(args.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
  const { version, problems } = checkRelease(root, { tag: args.tag })
  for (const problem of problems) console.error(problem)
  if (problems.length) process.exit(1)
  console.log(`release check passed: ${version}`)
}
