import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { USAGE as SECTION_USAGE, absoluteLinks, changelogSection, fencedLines, hasEntries, parseArgs as sectionArgs } from './changelog-section.mjs'
import { USAGE, checkChangelog, checkLock, checkRelease, checkTag, hardCodedVersions, isSemVer, parseArgs } from './check-release.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CHECK = path.join(HERE, 'check-release.mjs')
const SECTION = path.join(HERE, 'changelog-section.mjs')
const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })

const REPO = 'https://github.com/Osman19702/PromptFixer'
const CHANGELOG = `# Changelog

## [Unreleased]

## [0.2.0] - 2026-09-17

### Added

- Marks on a rewrite.

### Fixed

- Saving the library on Windows.

## [0.1.0] - 2026-09-11

First public release.

[Unreleased]: ${REPO}/compare/v0.2.0...HEAD
[0.2.0]: ${REPO}/compare/v0.1.0...v0.2.0
[0.1.0]: ${REPO}/releases/tag/v0.1.0
`

/** The changelog above with another body under [0.2.0]; the heading is line 5, the body starts on line 7. */
const withSection = (body) => CHANGELOG.replace(/(## \[0\.2\.0\][^\n]*\n\n)[^]*?(?=\n\n## \[0\.1\.0\])/, (_all, heading) => heading + body)

// The handler as it should be: the number is read, not written down.
const SERVER = `import fs from 'node:fs'
const { version: VERSION } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const HOST = '127.0.0.1'

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, version: VERSION })
})

app.get('/api/library/export', (_req, res) => {
  res.json({ version: 1, entries: [] })
})
`
const STALE_HANDLER = `app.get('/api/health', (_req, res) => {
  res.json({ ok: true, version: '0.1.0' })
})
`

const lock = (top, inner = top) => JSON.stringify({ name: 'promptfixer', version: top, lockfileVersion: 3, packages: { '': { name: 'promptfixer', version: inner } } })

/** A checkout that passes; `files` replaces a file, or removes it with null. */
function checkout(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-release-'))
  const all = {
    'package.json': JSON.stringify({ name: 'promptfixer', version: '0.2.0' }),
    'package-lock.json': lock('0.2.0'),
    'CHANGELOG.md': CHANGELOG,
    'server/index.js': SERVER,
    ...files,
  }
  for (const [rel, content] of Object.entries(all)) {
    if (content === null) continue
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), content)
  }
  return root
}

/** The problems of a checkout built from `files`, which is removed again. */
function problemsOf(files, options) {
  const root = checkout(files)
  try {
    return checkRelease(root, options).problems
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

/** Exactly one problem, and it says what is wrong. */
function assertOne(problems, pattern) {
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.match(problems[0], pattern)
}

test('a checkout whose version agrees everywhere passes, tagged or not', () => {
  const root = checkout()
  try {
    assert.deepEqual(checkRelease(root), { version: '0.2.0', problems: [] })
    assert.deepEqual(checkRelease(root, { tag: 'v0.2.0' }), { version: '0.2.0', problems: [] })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a changelog checked out with CRLF line endings passes like any other', () => {
  assert.deepEqual(problemsOf({ 'CHANGELOG.md': CHANGELOG.replace(/\n/g, '\r\n'), 'server/index.js': SERVER.replace(/\n/g, '\r\n') }, { tag: 'v0.2.0' }), [])
})

test('isSemVer takes the semver.org grammar and nothing looser', () => {
  for (const ok of ['0.2.0', '1.0.0', '10.20.30', '1.0.0-rc.1', '1.0.0-alpha+build.5', '1.0.0+20260917']) assert.equal(isSemVer(ok), true, ok)
  for (const bad of ['1.2', '1.2.3.4', 'v1.2.3', '01.2.3', '1.2.3-', '1.2.x', '', ' 1.2.3', undefined, 1]) assert.equal(isSemVer(bad), false, String(bad))
})

test('package.json: a missing file, broken JSON and a version that is not SemVer each stop the check', () => {
  assertOne(problemsOf({ 'package.json': null }), /^package\.json: missing$/)
  assertOne(problemsOf({ 'package.json': '{ nope' }), /^package\.json: cannot be read/)
  assertOne(problemsOf({ 'package.json': JSON.stringify({ version: '0.2' }) }), /^package\.json: version "0\.2" is not a Semantic Version/)
  assertOne(problemsOf({ 'package.json': JSON.stringify({ name: 'promptfixer' }) }), /version undefined is not a Semantic Version/)
})

test('package-lock.json must carry the version in both places', () => {
  assertOne(problemsOf({ 'package-lock.json': lock('0.1.0', '0.2.0') }), /^package-lock\.json: version is 0\.1\.0, package\.json says 0\.2\.0/)
  assertOne(problemsOf({ 'package-lock.json': lock('0.2.0', '0.1.0') }), /^package-lock\.json: packages\[""\]\.version is 0\.1\.0/)
  assertOne(problemsOf({ 'package-lock.json': null }), /^package-lock\.json: missing$/)
  assert.equal(checkLock('0.2.0', {}).length, 2)
  assert.match(checkLock('0.2.0', {})[1], /packages\[""\]\.version is missing/)
  assert.deepEqual(checkLock('0.2.0', JSON.parse(lock('0.2.0'))), [])
})

test('CHANGELOG.md must exist and have a section for exactly this version', () => {
  assertOne(problemsOf({ 'CHANGELOG.md': null }), /^CHANGELOG\.md: missing$/)
  assertOne(problemsOf({ 'CHANGELOG.md': CHANGELOG.replace('## [0.2.0] - 2026-09-17', '## [0.2.1] - 2026-09-17') }), /^CHANGELOG\.md has no section for 0\.2\.0/)
  // 0.2.0 must not be satisfied by 0.2.0-rc.1 or 10.2.0.
  assertOne(checkChangelog(CHANGELOG.replace('## [0.2.0] -', '## [0.2.0-rc.1] -'), '0.2.0'), /no section for 0\.2\.0/)
})

test('the newest section has to be the version in package.json: one line, not its consequences', () => {
  // The state between writing the 0.2.0 section and running npm version.
  const stale = { 'package.json': JSON.stringify({ version: '0.1.0' }), 'package-lock.json': lock('0.1.0') }
  assertOne(problemsOf(stale), /^CHANGELOG\.md: the newest section is \[0\.2\.0\] but package\.json says 0\.1\.0.*npm version 0\.2\.0 --no-git-tag-version/)
})

test('[Unreleased] must exist, above the released sections', () => {
  assertOne(checkChangelog(CHANGELOG.replace('## [Unreleased]\n\n', ''), '0.2.0'), /has no "## \[Unreleased\]" section/)
  const below = CHANGELOG.replace('## [Unreleased]\n\n', '').replace('## [0.1.0] -', '## [Unreleased]\n\n## [0.1.0] -')
  assertOne(checkChangelog(below, '0.2.0'), /\[Unreleased\] belongs above \[0\.2\.0\]/)
})

test('the section needs a real date', () => {
  assertOne(checkChangelog(CHANGELOG.replace('## [0.2.0] - 2026-09-17', '## [0.2.0]'), '0.2.0'), /CHANGELOG\.md:5: the \[0\.2\.0\] heading needs its release date/)
  assertOne(checkChangelog(CHANGELOG.replace('## [0.2.0] - 2026-09-17', '## [0.2.0] - 17 September 2026'), '0.2.0'), /needs its release date/)
  assertOne(checkChangelog(CHANGELOG.replace('## [0.2.0] - 2026-09-17', '## [0.2.0] - 2026-02-30'), '0.2.0'), /needs its release date/)
  assertOne(checkChangelog(CHANGELOG.replace('## [0.2.0] - 2026-09-17', '## [0.2.0] - YYYY-MM-DD'), '0.2.0'), /needs its release date/)
})

test('a section of nothing but headings is empty', () => {
  const hollow = CHANGELOG.replace('- Marks on a rewrite.\n', '').replace('- Saving the library on Windows.\n', '')
  assertOne(checkChangelog(hollow, '0.2.0'), /the \[0\.2\.0\] section is empty/)
  const bare = CHANGELOG.replace(/## \[0\.2\.0\][^]*?(?=## \[0\.1\.0\])/, '## [0.2.0] - 2026-09-17\n\n')
  assertOne(checkChangelog(bare, '0.2.0'), /the \[0\.2\.0\] section is empty/)
})

test('both link references are checked, and where they point', () => {
  const without = (line) => CHANGELOG.split('\n').filter((l) => !l.startsWith(line)).join('\n')
  assertOne(checkChangelog(without('[0.2.0]:'), '0.2.0'), /no link reference "\[0\.2\.0\]: \.\.\."/)
  assertOne(checkChangelog(without('[Unreleased]:'), '0.2.0'), /no link reference "\[Unreleased\]: \.\.\."/)
  assertOne(checkChangelog(CHANGELOG.replace('compare/v0.1.0...v0.2.0', 'compare/v0.1.0...v0.1.1'), '0.2.0'), /the \[0\.2\.0\] link must end in v0\.2\.0/)
  // The line most often forgotten: [Unreleased] still compares from the release before.
  assertOne(checkChangelog(CHANGELOG.replace('compare/v0.2.0...HEAD', 'compare/v0.1.0...HEAD'), '0.2.0'), /the \[Unreleased\] link must compare v0\.2\.0\.\.\.HEAD/)
  // The first release has no earlier tag to compare with.
  assert.deepEqual(checkChangelog(CHANGELOG.replace('compare/v0.1.0...v0.2.0', 'releases/tag/v0.2.0'), '0.2.0'), [])
})

test('entries left under [Unreleased] fail a tagged check only', () => {
  const pending = CHANGELOG.replace('## [Unreleased]\n', '## [Unreleased]\n\n### Added\n\n- Not moved yet.\n')
  assert.deepEqual(checkChangelog(pending, '0.2.0'), [])
  assertOne(checkChangelog(pending, '0.2.0', { tagged: true }), /\[Unreleased\] still has entries/)
  // Headings left behind after the move are not entries.
  assert.deepEqual(checkChangelog(CHANGELOG.replace('## [Unreleased]\n', '## [Unreleased]\n\n### Added\n'), '0.2.0', { tagged: true }), [])
})

test('a tag has to be "v" + the version, exactly', () => {
  assert.deepEqual(checkTag('v0.2.0', '0.2.0'), [])
  for (const tag of ['v0.2.1', '0.2.0', 'V0.2.0', 'v0.2.0-rc.1', 'v0.2', 'refs/tags/v0.2.0']) assertOne(checkTag(tag, '0.2.0'), /does not match package\.json, which says 0\.2\.0: the tag for it is v0\.2\.0/)
  assertOne(problemsOf({}, { tag: 'v0.3.0' }), /^tag v0\.3\.0 does not match/)
})

test('a version written into the /api/health handler is found, whatever the number', () => {
  assert.deepEqual(hardCodedVersions(STALE_HANDLER, '0.2.0'), [{ line: 2, literal: '0.1.0', where: 'the /api/health handler' }])
  assert.deepEqual(hardCodedVersions(`app.get("/api/health", (_req, res) => res.json({ ok: true, version: "0.2.0-rc.1" }))\n`, '0.2.0'), [
    { line: 1, literal: '0.2.0-rc.1', where: 'the /api/health handler' },
  ])
  assertOne(problemsOf({ 'server/index.js': SERVER.replace('ok: true, version: VERSION', "ok: true, version: '0.1.0'") }), /^server\/index\.js:6: '0\.1\.0' is written into the \/api\/health handler; read the version from package\.json/)
})

test('the handler ends where its call closes: a version below it is another matter', () => {
  const source = `${STALE_HANDLER.replace("'0.1.0'", 'VERSION')}\nconst MIN_OLLAMA = '0.5.7'\nconst OWN = '0.2.0'\n`
  assert.deepEqual(hardCodedVersions(source, '0.2.0'), [{ line: 6, literal: '0.2.0', where: 'the source' }])
})

test('reading the version, an address and the library envelope are not versions written down', () => {
  assert.deepEqual(hardCodedVersions(SERVER, '0.2.0'), [])
  assert.deepEqual(hardCodedVersions(`const a = '127.0.0.1'\nconst b = "10.0.0.255"\nconst c = { version: 1 }\n`, '0.0.1'), [])
})

test('only the sources that ship are searched: not tests, not the library, not node_modules', () => {
  const copy = `export const V = '0.2.0'\n`
  assert.deepEqual(problemsOf({ 'server/e2e.test.js': copy, 'server/data/notes.js': copy, 'server/node_modules/x/index.js': copy, 'scripts/tool.mjs': copy, 'src/types.d.ts': copy }), [])
  assertOne(problemsOf({ 'src/lib/about.ts': copy }), /^src\/lib\/about\.ts:1: '0\.2\.0' is written into the source/)
  assertOne(problemsOf({ 'electron/main.js': copy }), /^electron\/main\.js:1:/)
})

test('every problem is reported, one line each', () => {
  const problems = problemsOf({ 'package-lock.json': lock('0.1.0'), 'server/index.js': STALE_HANDLER, 'CHANGELOG.md': CHANGELOG.replace(' - 2026-09-17', '') }, { tag: 'v0.2.1' })
  assert.equal(problems.length, 5, problems.join('\n'))
  for (const p of problems) assert.doesNotMatch(p, /\n/)
})

test('changelogSection returns the body between two headings, for the notes of a release', () => {
  assert.equal(changelogSection(CHANGELOG, '0.2.0'), '### Added\n\n- Marks on a rewrite.\n\n### Fixed\n\n- Saving the library on Windows.')
  // The oldest section ends at the link references, not at the end of the file.
  assert.equal(changelogSection(CHANGELOG, '0.1.0'), 'First public release.')
  assert.equal(changelogSection(CHANGELOG.replace(/\n/g, '\r\n'), '0.1.0'), 'First public release.')
  assert.equal(changelogSection(CHANGELOG, 'Unreleased'), '')
  assert.equal(changelogSection(CHANGELOG, '0.3.0'), null)
  assert.equal(changelogSection(CHANGELOG, '0.2'), null)
})

test('a link reference between two entries belongs to the section: the entry after it is not lost', () => {
  const body = '### Added\n\n- Marks, see [docs].\n\n[docs]: https://example.com\n\n- The entry after the reference.'
  assert.equal(changelogSection(withSection(body), '0.2.0'), body)
  assert.deepEqual(checkChangelog(withSection(body), '0.2.0', { tagged: true }), [])
  // The oldest section has one of its own and still stops at the block that closes the file.
  const oldest = 'First, see [site].\n\n[site]: https://example.com\n\nLast line.'
  assert.equal(changelogSection(CHANGELOG.replace('First public release.', oldest), '0.1.0'), oldest)
  assert.equal(changelogSection(CHANGELOG.replace('First public release.', oldest).replace(/\n/g, '\r\n'), '0.1.0'), oldest)
  // A changelog without references at the bottom ends where the file does.
  assert.equal(changelogSection('## [0.1.0] - 2026-09-11\n\n- Only.\n', '0.1.0'), '- Only.')
})

test('a heading quoted in a code fence is an example: it ends no section and names no version', () => {
  const body = '### Added\n\n- A heading looks like this:\n\n```md\n## [9.9.9] - 2027-01-01\n\n[9.9.9]: https://example.com/v9.9.9\n```\n\n- The entry after the fence.'
  assert.equal(changelogSection(withSection(body), '0.2.0'), body)
  assert.equal(changelogSection(withSection(body), '9.9.9'), null)
  assert.deepEqual(checkChangelog(withSection(body), '0.2.0', { tagged: true }), [])
  // An introduction that shows the format: read as headings, 9.9.9 would be the newest section and "## Example" a stray one.
  const intro = withSection(body).replace('# Changelog\n', '# Changelog\n\nA section starts like this:\n\n```md\n## [9.9.9] - 2027-01-01\n## Example\n```\n')
  assert.deepEqual(checkChangelog(intro, '0.2.0', { tagged: true }), [])
  assert.deepEqual(checkChangelog(intro.replace(/\n/g, '\r\n'), '0.2.0', { tagged: true }), [])
  // A longer fence holds a shorter one, and tildes fence as well.
  const nested = '- Before.\n\n~~~~\n~~~\n## [9.9.9] - 2027-01-01\n~~~\n~~~~\n\n- After.'
  assert.equal(changelogSection(withSection(nested), '0.2.0'), nested)
})

test('fencedLines: what opens a fence, and what closes it', () => {
  assert.deepEqual(fencedLines(['a', '```js', '## x', '```', 'b']), [false, true, true, true, false])
  // Indented under a list item; a tilde line does not close a backtick fence, nor does one with text after it.
  assert.deepEqual(fencedLines(['  ```', '~~~', '## x', '``` js', '  ```', 'b']), [true, true, true, true, true, false])
  assert.deepEqual(fencedLines(['```js``` is a code span', 'b']), [false, false])
  // Never closed: fenced to the end, as Markdown renders it.
  assert.deepEqual(fencedLines(['```', 'a']), [true, true])
})

test('a "## " line that is not a version heading is refused: the section would end there', () => {
  const stray = withSection('### Added\n\n- One.\n\n## Notes\n\n- Two.')
  assert.equal(changelogSection(stray, '0.2.0'), '### Added\n\n- One.')
  assertOne(checkChangelog(stray, '0.2.0'), /^CHANGELOG\.md:11: "## Notes" is not a version heading.*"###"/)
  assertOne(checkChangelog(CHANGELOG.replace('## [0.1.0] - 2026-09-11', '## 0.1.0 - 2026-09-11'), '0.2.0'), /^CHANGELOG\.md:15: "## 0\.1\.0 - 2026-09-11" is not a version heading/)
})

test('hasEntries: headings and link references alone are not entries', () => {
  assert.equal(hasEntries('### Added\n\n- x'), true)
  assert.equal(hasEntries('Prose counts.'), true)
  for (const hollow of [null, '', '### Added\n\n### Fixed', '### Added\n\n[docs]: https://example.com\n']) assert.equal(hasEntries(hollow), false, String(hollow))
  assertOne(checkChangelog(withSection('### Added\n\n[docs]: https://example.com'), '0.2.0'), /the \[0\.2\.0\] section is empty/)
})

test('absoluteLinks: relative links get the base, for notes that leave the repository', () => {
  const BASE = `${REPO}/blob/v0.2.0`
  const abs = (markdown) => absoluteLinks(markdown, BASE)
  assert.equal(abs('- The checklist in [docs/RELEASING.md](docs/RELEASING.md), and more.'), `- The checklist in [docs/RELEASING.md](${BASE}/docs/RELEASING.md), and more.`)
  assert.equal(abs('[a](./docs/a.md#part) [b](/docs/b.md) [c](#010---2026-09-11)'), `[a](${BASE}/docs/a.md#part) [b](${BASE}/docs/b.md) [c](${BASE}/CHANGELOG.md#010---2026-09-11)`)
  // The link text may be a code span, may wrap onto the next line, and the link may have a title.
  assert.equal(abs('[`npm test`](docs/TESTS.md "the tiers")'), `[\`npm test\`](${BASE}/docs/TESTS.md "the tiers")`)
  assert.equal(abs('- see [the release\n  checklist](docs/RELEASING.md)'), `- see [the release\n  checklist](${BASE}/docs/RELEASING.md)`)
  // An image needs the file, not the page about it.
  assert.equal(abs('![the marks bar](docs/marks.png)'), `![the marks bar](${REPO}/raw/v0.2.0/docs/marks.png)`)
  assert.equal(abs('see [docs] and [site]\n\n[docs]: docs/a.md\n[site]: https://example.com\n[^1]: docs/a.md is prose in a footnote'), `see [docs] and [site]\n\n[docs]: ${BASE}/docs/a.md\n[site]: https://example.com\n[^1]: docs/a.md is prose in a footnote`)
  assert.equal(absoluteLinks('[x](docs/a.md)', `${BASE}/`), `[x](${BASE}/docs/a.md)`)
})

test('absoluteLinks leaves absolute links, code and things that only look like links alone', () => {
  const abs = (markdown) => absoluteLinks(markdown, `${REPO}/blob/v0.2.0`)
  for (const same of [
    '[x](https://example.com/a)',
    '[m](mailto:someone@example.com)',
    '[p](//example.com/a)',
    'a path in brackets (docs/a.md), [Unreleased] (see below)',
    'the syntax is `[text](docs/a.md)`',
    '``[text](docs/a.md) with a ` in it``',
    '```md\n[text](docs/a.md)\n```',
  ]) assert.equal(abs(same), same)
  // Around a fence and after a code span the rewriting goes on.
  assert.equal(abs('`code` [x](a.md)\n\n~~~\n[y](b.md)\n~~~\n\n[z](c.md)'), `\`code\` [x](${REPO}/blob/v0.2.0/a.md)\n\n~~~\n[y](b.md)\n~~~\n\n[z](${REPO}/blob/v0.2.0/c.md)`)
})

test('changelog-section parseArgs: one version, --file and --links with a value each', () => {
  assert.deepEqual(sectionArgs(['0.2.0']), { version: '0.2.0' })
  assert.deepEqual(sectionArgs(['--links', 'https://x/blob/v0.2.0', '0.2.0', '--file', 'C.md']), { version: '0.2.0', links: 'https://x/blob/v0.2.0', file: 'C.md' })
  assert.match(sectionArgs([]).error, /which version/)
  assert.match(sectionArgs(['--file', 'C.md']).error, /which version/)
  assert.match(sectionArgs(['0.2.0', '--links']).error, /--links needs a value/)
  assert.match(sectionArgs(['0.2.0', '--file', '--links', 'x']).error, /--file needs a value/)
  assert.match(sectionArgs(['0.2.0', '0.1.0']).error, /one version at a time/)
  assert.match(sectionArgs(['0.2.0', '--base', 'x']).error, /unknown argument: --base/)
})

test('parseArgs takes --tag and --root, each with a value, and nothing else', () => {
  assert.deepEqual(parseArgs([]), {})
  assert.deepEqual(parseArgs(['--tag', 'v0.2.0', '--root', 'x']), { tag: 'v0.2.0', root: 'x' })
  assert.match(parseArgs(['--tag']).error, /--tag needs a value/)
  assert.match(parseArgs(['--tag', '--root', 'x']).error, /--tag needs a value/)
  assert.match(parseArgs(['--tag', '']).error, /--tag needs a value/)
  assert.match(parseArgs(['v0.2.0']).error, /unknown argument: v0\.2\.0/)
  assert.match(parseArgs(['--fix']).error, /unknown argument: --fix/)
})

test('CLI: exit 0 and one line when the check passes', () => {
  const root = checkout()
  try {
    const plain = run(CHECK, ['--root', root])
    assert.equal(plain.status, 0, plain.stderr)
    assert.equal(plain.stdout, 'release check passed: 0.2.0\n')
    assert.equal(plain.stderr, '')
    assert.equal(run(CHECK, ['--root', root, '--tag', 'v0.2.0']).status, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('CLI: exit 1 and one line per problem on stderr', () => {
  const root = checkout({ 'package-lock.json': lock('0.1.0', '0.2.0'), 'server/index.js': STALE_HANDLER })
  try {
    const bad = run(CHECK, ['--root', root, '--tag', 'v9.9.9'])
    assert.equal(bad.status, 1)
    assert.equal(bad.stdout, '')
    const lines = bad.stderr.trimEnd().split('\n')
    assert.equal(lines.length, 3, bad.stderr)
    assert.match(lines[0], /^package-lock\.json: version is 0\.1\.0/)
    assert.match(lines[1], /^server\/index\.js:2: '0\.1\.0'/)
    assert.match(lines[2], /^tag v9\.9\.9 does not match/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('CLI: a command line that makes no sense is exit 2 with the usage', () => {
  for (const args of [['--tag'], ['--bogus']]) {
    const bad = run(CHECK, args)
    assert.equal(bad.status, 2, args.join(' '))
    assert.ok(bad.stderr.includes(USAGE), bad.stderr)
  }
})

test('changelog-section CLI: prints the section, exit 1 without one, exit 2 without a version', () => {
  const root = checkout({ 'EMPTY.md': '## [0.3.0] - 2026-10-01\n\n## [0.2.0] - 2026-09-17\n\n- x\n' })
  try {
    const file = path.join(root, 'CHANGELOG.md')
    const ok = run(SECTION, ['0.1.0', '--file', file])
    assert.equal(ok.status, 0, ok.stderr)
    assert.equal(ok.stdout, 'First public release.\n')

    const none = run(SECTION, ['0.3.0', '--file', file])
    assert.equal(none.status, 1)
    assert.equal(none.stdout, '')
    assert.match(none.stderr, /CHANGELOG\.md has no section for 0\.3\.0/)

    const empty = run(SECTION, ['0.3.0', '--file', path.join(root, 'EMPTY.md')])
    assert.equal(empty.status, 1)
    assert.match(empty.stderr, /the section for 0\.3\.0 is empty/)

    // Headings alone are no release notes either.
    fs.writeFileSync(path.join(root, 'HOLLOW.md'), '## [0.3.0] - 2026-10-01\n\n### Added\n\n## [0.2.0] - 2026-09-17\n\n- x\n')
    const hollow = run(SECTION, ['0.3.0', '--file', path.join(root, 'HOLLOW.md')])
    assert.equal(hollow.status, 1)
    assert.equal(hollow.stdout, '')
    assert.match(hollow.stderr, /the section for 0\.3\.0 is empty/)

    for (const args of [[], ['0.1.0', '--file'], ['0.1.0', '--links']]) {
      const bad = run(SECTION, args)
      assert.equal(bad.status, 2, args.join(' '))
      assert.ok(bad.stderr.includes(SECTION_USAGE), bad.stderr)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('changelog-section CLI: --links makes the relative links of the printed section absolute', () => {
  const linked = withSection('### Added\n\n- The checklist in [docs/RELEASING.md](docs/RELEASING.md) and [Elastishot](https://github.com/Osman19702/elastishot).')
  const root = checkout({ 'CHANGELOG.md': linked.replace(/\n/g, '\r\n') })
  try {
    const file = path.join(root, 'CHANGELOG.md')
    const out = run(SECTION, ['0.2.0', '--file', file, '--links', `${REPO}/blob/v0.2.0`])
    assert.equal(out.status, 0, out.stderr)
    assert.equal(out.stdout, `### Added\n\n- The checklist in [docs/RELEASING.md](${REPO}/blob/v0.2.0/docs/RELEASING.md) and [Elastishot](https://github.com/Osman19702/elastishot).\n`)
    // Without the flag the section is printed as it is written.
    assert.match(run(SECTION, ['0.2.0', '--file', file]).stdout, /\]\(docs\/RELEASING\.md\)/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
