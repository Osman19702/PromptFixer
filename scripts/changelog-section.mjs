#!/usr/bin/env node
/**
 * Print the CHANGELOG.md section of one version, for release notes.
 *
 *   node scripts/changelog-section.mjs 0.2.0                  the body under "## [0.2.0] - ..."
 *   node scripts/changelog-section.mjs 0.2.0 --file <path>    read another changelog
 *   node scripts/changelog-section.mjs 0.2.0 --links <base>   make the section's relative links absolute
 *
 * --links is for notes that leave the repository. On a GitHub release page
 * "docs/RELEASING.md" resolves against /releases/tag/ and answers 404, so the
 * Release workflow passes https://github.com/<owner>/<repo>/blob/<tag>.
 *
 * Exits 1 when the version has no section or the section has no entries, so a
 * release cannot ship without its changelog entry. Usage errors exit 2.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const CHANGELOG = 'CHANGELOG.md'
export const USAGE = 'usage: changelog-section.mjs <version> [--file <path>] [--links <base url>]'

/** "## [0.2.0] - 2026-09-17" and "## [Unreleased]": the name, and whatever follows the bracket. */
export const SECTION_HEADING = /^## \[([^\]]+)\](.*)$/
/** "[0.2.0]: https://..." — a link reference; a block of them closes the file. */
export const LINK_REFERENCE = /^\[([^\]]+)\]:\s*(\S+)\s*$/

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/

/**
 * For every line, whether it belongs to a fenced code block (the fence lines
 * included). A "## [x.y.z] - YYYY-MM-DD" quoted in one is an example, not a
 * heading, and a link in one is not a link.
 */
export function fencedLines(lines) {
  let open = null
  return lines.map((line) => {
    const [, fence, rest] = FENCE.exec(line) ?? []
    if (open) {
      // Closed by the same character, at least as long, with nothing after it.
      if (fence && fence[0] === open[0] && fence.length >= open.length && !rest.trim()) open = null
      return true
    }
    // "```js" opens a block; "```js``` inline" is a code span.
    if (fence && !(fence[0] === '`' && rest.includes('`'))) open = fence
    return open !== null
  })
}

/** A section that holds only "### Added" headings or link references says nothing, and the release notes would say the same. */
export const hasEntries = (body) => (body ?? '').split('\n').some((l) => l.trim() && !l.startsWith('#') && !LINK_REFERENCE.test(l))

/**
 * The text under one version's heading, trimmed; '' for a heading with
 * nothing under it and null when there is no such heading. `name` may be
 * "Unreleased". A section ends at the next "## " heading, and the last one at
 * the block of link references that closes the file. A link reference between
 * two entries belongs to the section, and so does anything inside a code
 * fence: ending there would cut the release notes short without a word.
 */
export function changelogSection(text, name) {
  // A checkout on Windows has CRLF line endings; the notes should not.
  const lines = text.split(/\r?\n/)
  const fenced = fencedLines(lines)
  const start = lines.findIndex((l, i) => !fenced[i] && SECTION_HEADING.exec(l)?.[1] === name)
  if (start < 0) return null
  let end = lines.length
  while (end > start + 1 && !fenced[end - 1] && (!lines[end - 1].trim() || LINK_REFERENCE.test(lines[end - 1]))) end--
  const next = lines.findIndex((l, i) => i > start && i < end && !fenced[i] && l.startsWith('## '))
  return lines
    .slice(start + 1, next < 0 ? end : next)
    .join('\n')
    .trim()
}

const HAS_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i
// A code span, which is left alone, or an inline link or image. The link's
// text may hold a code span and may wrap onto the next line.
const CODE_OR_LINK = /(`+).*?\1|(!?)\[((?:`[^`]*`|[^\]`])*)\]\(\s*([^()\s]+)(\s+"[^"]*")?\s*\)/g
// Not "[^1]: ...": that is a footnote, and what follows it is prose.
const REFERENCE_TARGET = /^(\[(?!\^)[^\]]+\]:\s*)(\S+)/gm

/**
 * `markdown` with every relative link target made absolute under `base`, the
 * URL of the repository's root at one ref (".../blob/v0.2.0"). "#anchor"
 * points into the changelog itself. Code spans and code fences are not touched.
 */
export function absoluteLinks(markdown, base) {
  const root = base.replace(/\/+$/, '')
  const absolute = (target, image) => {
    if (HAS_SCHEME.test(target)) return target
    // An image needs the file itself, not the page GitHub shows it on.
    const under = image ? root.replace('/blob/', '/raw/') : root
    return target.startsWith('#') ? `${under}/${CHANGELOG}${target}` : `${under}/${target.replace(/^(?:\.?\/)+/, '')}`
  }
  const rewrite = (chunk) =>
    chunk
      .replace(CODE_OR_LINK, (all, code, bang, text, target, title = '') => (code ? all : `${bang}[${text}](${absolute(target, bang === '!')}${title})`))
      .replace(REFERENCE_TARGET, (_all, label, target) => `${label}${absolute(target, false)}`)

  const lines = markdown.split('\n')
  const fenced = fencedLines(lines)
  const out = []
  let chunk = []
  const flush = () => {
    if (chunk.length) out.push(rewrite(chunk.join('\n')))
    chunk = []
  }
  lines.forEach((line, i) => {
    if (!fenced[i]) return chunk.push(line)
    flush()
    out.push(line)
  })
  flush()
  return out.join('\n')
}

/** `{ version, file, links }`, or `{ error }` for a command line that makes no sense. */
export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--file' || arg === '--links') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) return { error: `${arg} needs a value` }
      out[arg.slice(2)] = value
    } else if (arg.startsWith('--')) return { error: `unknown argument: ${arg}` }
    else if (out.version) return { error: `one version at a time: ${out.version}, ${arg}` }
    else out.version = arg
  }
  return out.version ? out : { error: 'which version?' }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  if (args.error) {
    console.error(`${args.error}\n${USAGE}`)
    process.exit(2)
  }
  const file = args.file ? path.resolve(args.file) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', CHANGELOG)
  const section = changelogSection(fs.readFileSync(file, 'utf8'), args.version)
  if (!hasEntries(section)) {
    console.error(section === null ? `${CHANGELOG} has no section for ${args.version}` : `${CHANGELOG}: the section for ${args.version} is empty`)
    process.exit(1)
  }
  process.stdout.write(`${args.links ? absoluteLinks(section, args.links) : section}\n`)
}
