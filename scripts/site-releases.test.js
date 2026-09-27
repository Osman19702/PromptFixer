import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  USAGE,
  collectReleases,
  fetchReleases,
  hashFromBody,
  installerOf,
  parseArgs,
  parseSums,
  repoFromPackage,
  splitNotes,
  sumsAssetOf,
  toSiteReleases,
} from './site-releases.mjs'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'site-releases.mjs')
const REPO = 'Osman19702/PromptFixer'
const GH = `https://github.com/${REPO}`

// The hashes of the three real releases, so a fixture reads like the release page it is modelled on.
const SHA_030 = '39dde4aaf5e9ac4b059d256280002211d5e78a89ffc65dc375e7965c5d71b0d7'
const SHA_020 = '0388c49399efb895036f2f75e8a7b09803d613bb56850d9644ed17c7c0b9853e'
const SHA_010 = '4f49a75fa3b01cbf98cee56100e2afdc14b42b56b1eef3853e47afc010194c2e'
const BLOCKMAP_030 = 'cceb5d24df78baa274d6802e7defe61abe8188a30d0137b2893c873e37c13259'
const SUMS_030 = `${SHA_030}  PromptFixer-0.3.0-win-x64.exe\n${BLOCKMAP_030}  PromptFixer-0.3.0-win-x64.exe.blockmap\n`

/** The notes of 0.3.0 as the site should show them: what the changelog said, and nothing of the download block. */
const NOTES_030 = [
  '### Added',
  '',
  '- `npm run visual -- --against <ref>` compares the interface with a commit instead of with',
  '  approved pictures: the ref is checked out into `.elastishot/against/<sha>`, built there and',
  '  served by its own server. Nothing has to be approved or committed first.',
  '- **Every saved result records the build that produced it.** A library entry gains `appVersion`,',
  '  and `GET /api/library/export` gains one for the file as a whole.',
  '',
  '### Changed',
  '',
  '- The line beside the Fix button --- there was none --- says which wait this is.',
  '',
  '### Fixed',
  '',
  '- A cloud provider that answers with a status code now arrives as the last line of the stream',
  `  (see [docs/RELEASING.md](${GH}/blob/v0.3.0/docs/RELEASING.md)).`,
].join('\n')

/** The block the Release workflow appends after the changelog section. */
const downloadBlock = (version, sha) =>
  [
    '---',
    '',
    `**Download:** \`PromptFixer-${version}-win-x64.exe\` (339 MiB). Windows 10/11, 64-bit. The model (2.5 GB, or the 1 GB "lite" tier) is downloaded on first run; installing over an earlier version keeps your library and the model.`,
    '',
    `**Verify:** installer SHA-256 \`${sha}\` (\`SHA256SUMS.txt\` is attached). PowerShell: \`(Get-FileHash .\\PromptFixer-${version}-win-x64.exe).Hash.ToLower()\` must equal it.`,
    '',
    `**Not code-signed yet:** Windows shows "Windows protected your PC" - *More info*, then *Run anyway*. Compare the hash first. Full guide: [docs/INSTALL.md](${GH}/blob/v${version}/docs/INSTALL.md).`,
    '',
    `Built by [the Release workflow](${GH}/actions/runs/35626360607) from commit 502d6752881079f276a342ae810aab78412d6654.`,
  ].join('\n')

// The API returns the body as the editor on GitHub saved it, with CRLF.
const BODY_030 = `${NOTES_030}\n\n${downloadBlock('0.3.0', SHA_030)}\n`.replace(/\n/g, '\r\n')
const BODY_020 = `### Added\r\n\r\n- **Fix again with your marks.** On the Fixed tab, select any passage of the rewrite and press\r\n  **Keep it — I loved it** or **Change it — I didn't like it**.\r\n\r\n${downloadBlock('0.2.0', SHA_020).replace(/\n/g, '\r\n')}\r\n`
// 0.1.0 was written by hand: no separator, and the hash is only in the prose.
const BODY_010 = `## PromptFixer 0.1.0 — Windows x64 installer\n\nLints, scores and rewrites LLM prompts with a built-in local model; nothing you type leaves your machine.\n\n**Download:** \`PromptFixer-0.1.0-win-x64.exe\` (~355 MB). Windows 10/11, 64-bit.\n\n**Verify:** installer SHA-256 \`${SHA_010}\` (\`SHA256SUMS.txt\` is attached).\n`

/**
 * What the API answers for the repository: the three real releases, a draft
 * for the next version and a pre-release newer than all of them, in an order
 * the API would not use. Downloads live under `base`, so the fake server can
 * serve them itself.
 */
function apiFixture(base = `${GH}/releases/download`) {
  const asset = (tag, name, size, state = 'uploaded') => ({
    name,
    state,
    size,
    content_type: 'application/octet-stream',
    browser_download_url: `${base}/${tag}/${name}`,
  })
  const windows = (tag, version, bytes) => [
    asset(tag, `PromptFixer-${version}-win-x64.exe`, bytes),
    asset(tag, `PromptFixer-${version}-win-x64.exe.blockmap`, 371803),
    asset(tag, 'SHA256SUMS.txt', 201),
  ]
  let id = 393123329
  const release = (tag, fields) => ({
    id: id++,
    tag_name: tag,
    name: `PromptFixer ${tag.slice(1)}`,
    draft: false,
    prerelease: false,
    target_commitish: 'master',
    html_url: `${GH}/releases/tag/${tag}`,
    assets: [],
    ...fields,
  })
  return [
    release('v0.2.0', {
      created_at: '2026-09-17T21:51:48Z',
      published_at: '2026-09-17T22:33:14Z',
      body: BODY_020,
      assets: windows('v0.2.0', '0.2.0', 355607044),
    }),
    release('v0.4.0-rc.1', {
      prerelease: true,
      created_at: '2026-09-25T09:00:00Z',
      published_at: '2026-09-25T09:05:00Z',
      body: '### Added\r\n\r\n- A rehearsal of the next release.\r\n',
    }),
    release('v0.3.0', {
      created_at: '2026-09-21T16:33:25Z',
      published_at: '2026-09-21T16:39:55Z',
      body: BODY_030,
      assets: windows('v0.3.0', '0.3.0', 355614523),
    }),
    release('v0.4.0', {
      draft: true,
      created_at: '2026-09-26T10:00:00Z',
      published_at: null,
      body: '### Added\r\n\r\n- Not out yet.\r\n',
      assets: windows('v0.4.0', '0.4.0', 355620000),
    }),
    release('v0.1.0', {
      name: 'PromptFixer 0.1.0 (Windows x64)',
      created_at: '2026-09-11T17:59:09Z',
      published_at: '2026-09-11T18:14:01Z',
      body: BODY_010,
      // The installer and its blockmap, but no SHA256SUMS.txt: the hash has to come from the notes.
      assets: windows('v0.1.0', '0.1.0', 355597508).slice(0, 2),
    }),
  ]
}

/** The 0.3.0 entry of site/releases.json, with downloads under `base`. */
const expected030 = (base = `${GH}/releases/download`) => ({
  tag: 'v0.3.0',
  version: '0.3.0',
  name: 'PromptFixer 0.3.0',
  publishedAt: '2026-09-21T16:39:55Z',
  prerelease: false,
  url: `${GH}/releases/tag/v0.3.0`,
  notes: NOTES_030,
  installer: {
    name: 'PromptFixer-0.3.0-win-x64.exe',
    url: `${base}/v0.3.0/PromptFixer-0.3.0-win-x64.exe`,
    bytes: 355614523,
    sha256: SHA_030,
    sumsUrl: `${base}/v0.3.0/SHA256SUMS.txt`,
  },
})

/** A fetch that answers from a table of URL -> { status, body } and records what it was asked. */
function fakeFetch(table, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url, headers: init.headers ?? {} })
    const hit = table[url]
    if (!hit) return new Response('{"message":"Not Found"}', { status: 404, statusText: 'Not Found' })
    if (hit.error) throw hit.error
    const body = typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body)
    return new Response(body, { status: hit.status ?? 200, statusText: hit.statusText ?? 'OK' })
  }
}

// A stand-in for api.github.com on a port the OS picks, the way
// server/e2e.test.js stands in for a cloud provider: the CLI is pointed at it
// through SITE_RELEASES_API_BASE. `requests` is everything it was asked.
let api
let apiBase = ''
const requests = []
const SUMS_020 = `${SHA_020}  PromptFixer-0.2.0-win-x64.exe\n${'0'.repeat(64)}  PromptFixer-0.2.0-win-x64.exe.blockmap\n`

before(
  () =>
    new Promise((resolve) => {
      api = http.createServer((req, res) => {
        requests.push({ url: req.url, headers: req.headers })
        const send = (status, type, body) => {
          res.writeHead(status, { 'content-type': type })
          res.end(body)
        }
        const json = (status, body) => send(status, 'application/json', JSON.stringify(body))
        switch (req.url) {
          case `/repos/${REPO}/releases?per_page=100`:
            return json(200, apiFixture(`${apiBase}/download`))
          case '/repos/forbidden/repo/releases?per_page=100':
            return json(403, { message: 'API rate limit exceeded for 203.0.113.7.', documentation_url: 'https://docs.github.com/rest' })
          case '/repos/empty/repo/releases?per_page=100':
            return json(200, [])
          case '/download/v0.3.0/SHA256SUMS.txt':
            return send(200, 'application/octet-stream', SUMS_030)
          case '/download/v0.2.0/SHA256SUMS.txt':
            return send(200, 'application/octet-stream', SUMS_020)
          default:
            return json(404, { message: 'Not Found' })
        }
      })
      api.listen(0, '127.0.0.1', () => {
        apiBase = `http://127.0.0.1:${api.address().port}`
        resolve()
      })
    })
)

after(() => new Promise((resolve) => api.close(resolve)))

// Pointed at the fake API, with a token so the Authorization header can be checked.
const env = () => ({ ...process.env, SITE_RELEASES_API_BASE: apiBase, GITHUB_TOKEN: 'test-token', GH_TOKEN: '' })

/** The CLI, for a command line it refuses before it asks the network anything. */
const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: env() })

/**
 * The CLI, awaited. The fake API lives in this process, so a run that asks
 * it anything has to be spawned asynchronously: spawnSync would block the
 * event loop the stub answers from, and the child would wait for ever.
 */
function runApi(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: env() })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

/** A temp dir for the file the CLI writes, removed again by `done`. */
function outDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-site-'))
  return { file: path.join(dir, 'nested', 'releases.json'), done: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

test('repoFromPackage reads owner/name out of every spelling package.json may hold', () => {
  assert.equal(repoFromPackage('git+https://github.com/Osman19702/PromptFixer.git'), REPO)
  assert.equal(repoFromPackage('https://github.com/Osman19702/PromptFixer'), REPO)
  assert.equal(repoFromPackage('https://github.com/Osman19702/PromptFixer/'), REPO)
  assert.equal(repoFromPackage('git@github.com:Osman19702/PromptFixer.git'), REPO)
  assert.equal(repoFromPackage('git+ssh://git@github.com/Osman19702/PromptFixer.git'), REPO)
  assert.equal(repoFromPackage('https://gitlab.com/Osman19702/PromptFixer.git'), null)
  assert.equal(repoFromPackage(''), null)
  assert.equal(repoFromPackage(undefined), null)
})

test('parseSums maps each listed file to its hash, lowercase, and skips lines that are not one', () => {
  const sums = parseSums(SUMS_030)
  assert.deepEqual([...sums], [
    ['PromptFixer-0.3.0-win-x64.exe', SHA_030],
    ['PromptFixer-0.3.0-win-x64.exe.blockmap', BLOCKMAP_030],
  ])
  const odd = parseSums(`${SHA_010.toUpperCase()} *PromptFixer-0.1.0-win-x64.exe\r\nnot a sum line\r\n\r\n`)
  assert.deepEqual([...odd], [['PromptFixer-0.1.0-win-x64.exe', SHA_010]])
  assert.equal(parseSums(null).size, 0)
})

test('splitNotes keeps the changelog and drops the download block after the "---" line', () => {
  assert.equal(splitNotes(BODY_030), NOTES_030)
  assert.ok(!splitNotes(BODY_030).includes('\r'), 'CRLF is normalised')
  assert.ok(splitNotes(BODY_030).includes('--- there was none ---'), 'a --- inside a line is not the separator')
  // No separator: the whole body, trimmed, and nothing else changed.
  assert.equal(splitNotes(BODY_010), BODY_010.trim())
  // Only a line that is exactly "---" cuts; a longer rule or an indented one is markdown to keep.
  assert.equal(splitNotes('one\n----\ntwo\n  ---\nthree\n---\nfour'), 'one\n----\ntwo\n  ---\nthree')
  assert.equal(splitNotes('one\r\n---\r\ntwo'), 'one')
  assert.equal(splitNotes(null), '')
})

test('hashFromBody finds the hash the Release workflow writes into the notes', () => {
  assert.equal(hashFromBody(BODY_030), SHA_030)
  assert.equal(hashFromBody(BODY_010), SHA_010)
  assert.equal(hashFromBody('### Added\n\n- Nothing to verify.\n'), null)
  assert.equal(hashFromBody(null), null)
})

test('installerOf takes the uploaded win-x64 installer and nothing else', () => {
  const [, , v030] = apiFixture()
  assert.deepEqual(installerOf(v030.assets), {
    name: 'PromptFixer-0.3.0-win-x64.exe',
    url: `${GH}/releases/download/v0.3.0/PromptFixer-0.3.0-win-x64.exe`,
    bytes: 355614523,
  })
  const [exe, blockmap, sums] = v030.assets
  assert.equal(installerOf([blockmap, sums]), null)
  assert.equal(installerOf([{ ...exe, state: 'open' }]), null, 'an upload that broke off is not an installer')
  assert.equal(installerOf([]), null)
  assert.equal(installerOf(undefined), null)
  assert.equal(sumsAssetOf(v030.assets), sums)
  assert.equal(sumsAssetOf([exe, blockmap]), null)
  assert.equal(sumsAssetOf([{ ...sums, state: 'open' }]), null)
})

test('toSiteReleases drops drafts, orders newest first and never makes a pre-release "latest"', () => {
  const sumsByTag = new Map([['v0.3.0', SUMS_030]])
  const { latest, releases } = toSiteReleases(apiFixture(), { sumsByTag })
  assert.equal(latest, 'v0.3.0')
  assert.deepEqual(
    releases.map((r) => [r.tag, r.version, r.prerelease]),
    [
      ['v0.4.0-rc.1', '0.4.0-rc.1', true],
      ['v0.3.0', '0.3.0', false],
      ['v0.2.0', '0.2.0', false],
      ['v0.1.0', '0.1.0', false],
    ]
  )
  assert.deepEqual(releases[1], expected030())
  // No installer at all: the field is there, and null.
  assert.equal(releases[0].installer, null)
  assert.equal(releases[0].notes, '### Added\n\n- A rehearsal of the next release.')
  // A plain object works as well as a Map.
  assert.deepEqual(toSiteReleases(apiFixture(), { sumsByTag: { 'v0.3.0': SUMS_030 } }).releases[1], expected030())
})

test('toSiteReleases prefers the hash in SHA256SUMS.txt and falls back to the notes', () => {
  const fixture = apiFixture()
  const other = 'a'.repeat(64)
  const sumsByTag = new Map([['v0.3.0', `${other}  PromptFixer-0.3.0-win-x64.exe\n`], ['v0.2.0', SUMS_030]])
  const { releases } = toSiteReleases(fixture, { sumsByTag })
  const of = (tag) => releases.find((r) => r.tag === tag).installer
  // The sums say one thing and the notes another: the sums win, they are what sha256sum -c checks against.
  assert.equal(of('v0.3.0').sha256, other)
  // The sums are for another file: the notes.
  assert.equal(of('v0.2.0').sha256, SHA_020)
  assert.equal(of('v0.2.0').sumsUrl, `${GH}/releases/download/v0.2.0/SHA256SUMS.txt`)
  // No sums asset and none fetched: the notes, and no sumsUrl to offer.
  assert.equal(of('v0.1.0').sha256, SHA_010)
  assert.equal(of('v0.1.0').sumsUrl, null)
  // Neither: null, never a guess.
  const silent = fixture.map((r) => (r.tag_name === 'v0.1.0' ? { ...r, body: '### Added\n\n- No hash here.\n' } : r))
  assert.equal(toSiteReleases(silent).releases.find((r) => r.tag === 'v0.1.0').installer.sha256, null)
  assert.deepEqual(toSiteReleases([]), { latest: null, releases: [] })
  assert.deepEqual(toSiteReleases([fixture[1]]), { latest: null, releases: toSiteReleases([fixture[1]]).releases })
})

test('parseArgs takes --out and --repo, each with a value, and nothing else', () => {
  assert.deepEqual(parseArgs([]), {})
  assert.deepEqual(parseArgs(['--out', 'x.json', '--repo', 'a/b']), { out: 'x.json', repo: 'a/b' })
  assert.match(parseArgs(['--out']).error, /--out needs a value/)
  assert.match(parseArgs(['--out', '--repo', 'a/b']).error, /--out needs a value/)
  assert.match(parseArgs(['--repo', 'nonsense']).error, /--repo wants owner\/name/)
  assert.match(parseArgs(['--fix']).error, /unknown argument: --fix/)
  assert.match(parseArgs(['x.json']).error, /unknown argument: x\.json/)
})

test('collectReleases asks the API with the headers GitHub wants and downloads the sums without the token', async () => {
  const calls = []
  const fetch = fakeFetch(
    {
      [`https://api.github.com/repos/${REPO}/releases?per_page=100`]: { body: apiFixture() },
      [`${GH}/releases/download/v0.3.0/SHA256SUMS.txt`]: { body: SUMS_030 },
      [`${GH}/releases/download/v0.2.0/SHA256SUMS.txt`]: { body: SUMS_020 },
    },
    calls
  )
  const before = Date.now()
  const data = await collectReleases(REPO, { fetch, token: 'secret' })
  assert.deepEqual(Object.keys(data), ['generatedAt', 'repo', 'latest', 'releases'])
  assert.ok(Date.parse(data.generatedAt) >= before - 1000, 'generatedAt is the time of writing')
  assert.equal(data.repo, REPO)
  assert.equal(data.latest, 'v0.3.0')
  assert.deepEqual(data.releases[1], expected030())
  assert.equal(data.releases[2].installer.sha256, SHA_020)
  assert.equal(data.releases[3].installer.sha256, SHA_010)

  assert.deepEqual(
    calls.map((c) => c.url),
    [
      `https://api.github.com/repos/${REPO}/releases?per_page=100`,
      `${GH}/releases/download/v0.2.0/SHA256SUMS.txt`,
      `${GH}/releases/download/v0.3.0/SHA256SUMS.txt`,
    ],
    'the sums of every published release with an installer and a sums asset, and of nothing else'
  )
  assert.deepEqual(calls[0].headers, {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'PromptFixer-site-releases',
    Authorization: 'Bearer secret',
  })
  assert.equal(calls[1].headers.Authorization, undefined, 'a public asset gets no token; its download leaves github.com')

  const anonymous = []
  await collectReleases(REPO, { fetch: fakeFetch({ [`https://api.github.com/repos/${REPO}/releases?per_page=100`]: { body: [] } }, anonymous) })
  assert.equal(anonymous[0].headers.Authorization, undefined)
  // Another API base: the path is the same.
  const elsewhere = []
  await collectReleases(REPO, { fetch: fakeFetch({ [`http://127.0.0.1:9/repos/${REPO}/releases?per_page=100`]: { body: [] } }, elsewhere), apiBase: 'http://127.0.0.1:9/' })
  assert.equal(elsewhere.length, 1)
})

test('collectReleases fails on a status that is not 2xx, a body that is not a list and a network error', async () => {
  const url = `https://api.github.com/repos/${REPO}/releases?per_page=100`
  await assert.rejects(
    collectReleases(REPO, { fetch: fakeFetch({ [url]: { status: 403, statusText: 'Forbidden', body: { message: 'API rate limit exceeded' } } }) }),
    { message: `GET ${url}: 403 Forbidden (API rate limit exceeded)` }
  )
  await assert.rejects(collectReleases(REPO, { fetch: fakeFetch({ [url]: { body: '<html>Bad gateway</html>' } }) }), /is not JSON/)
  await assert.rejects(collectReleases(REPO, { fetch: fakeFetch({ [url]: { body: { message: 'one object' } } }) }), /is not a list of releases/)
  // What undici throws when nothing answers: the reason is in `cause`, and the log must show it.
  const down = new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9') })
  await assert.rejects(fetchReleases(REPO, { fetch: fakeFetch({ [url]: { error: down } }) }), { message: `GET ${url}: fetch failed (connect ECONNREFUSED 127.0.0.1:9)` })
  await assert.rejects(fetchReleases(REPO, { fetch: fakeFetch({ [url]: { error: new TypeError('fetch failed') } }) }), { message: `GET ${url}: fetch failed` })
  // A sums asset that is listed but cannot be fetched is not a reason to guess.
  const sumsUrl = `${GH}/releases/download/v0.3.0/SHA256SUMS.txt`
  await assert.rejects(
    collectReleases(REPO, { fetch: fakeFetch({ [url]: { body: [apiFixture()[2]] }, [sumsUrl]: { status: 502, statusText: 'Bad Gateway', body: 'nope' } }) }),
    { message: `GET ${sumsUrl}: 502 Bad Gateway` }
  )
})

test('CLI: a command line that makes no sense is exit 2 with the usage, and nothing is fetched', () => {
  const seen = requests.length
  for (const args of [['--bogus'], ['--out'], ['--out', '--repo', REPO], ['--repo', 'nonsense']]) {
    const bad = run(args)
    assert.equal(bad.status, 2, args.join(' '))
    assert.equal(bad.stdout, '')
    assert.ok(bad.stderr.includes(USAGE), bad.stderr)
  }
  assert.equal(requests.length, seen)
})

test('CLI: a 403 from the API is exit 1 with the status on stderr, and no file', async () => {
  const { file, done } = outDir()
  try {
    const bad = await runApi(['--repo', 'forbidden/repo', '--out', file])
    assert.equal(bad.status, 1)
    assert.equal(bad.stdout, '')
    assert.match(bad.stderr, /403 Forbidden \(API rate limit exceeded for 203\.0\.113\.7\.\)/)
    assert.match(bad.stderr, /is not written/)
    assert.equal(fs.existsSync(file), false)
  } finally {
    done()
  }
})

test('CLI: a repository without a published release is exit 1, and no file', async () => {
  const { file, done } = outDir()
  try {
    const bad = await runApi(['--repo', 'empty/repo', '--out', file])
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /empty\/repo has no published release/)
    assert.equal(fs.existsSync(file), false)
  } finally {
    done()
  }
})

test('CLI: writes the contract shape, two-space indented with a trailing newline, from the API and the sums', async () => {
  const { file, done } = outDir()
  try {
    const first = requests.length
    const ok = await runApi(['--repo', REPO, '--out', file])
    assert.equal(ok.status, 0, ok.stderr)
    assert.equal(ok.stdout, `wrote ${path.relative(process.cwd(), file)}: 4 release(s) of ${REPO}, latest v0.3.0\n`)
    const lines = ok.stderr.trimEnd().split('\n')
    assert.deepEqual(lines, [
      'v0.4.0-rc.1 (pre-release): no Windows installer',
      `v0.3.0: PromptFixer-0.3.0-win-x64.exe, 355614523 bytes, sha256 ${SHA_030}`,
      `v0.2.0: PromptFixer-0.2.0-win-x64.exe, 355607044 bytes, sha256 ${SHA_020}`,
      `v0.1.0: PromptFixer-0.1.0-win-x64.exe, 355597508 bytes, sha256 ${SHA_010}`,
    ])

    const text = fs.readFileSync(file, 'utf8')
    const data = JSON.parse(text)
    assert.equal(text, `${JSON.stringify(data, null, 2)}\n`)
    assert.deepEqual(Object.keys(data), ['generatedAt', 'repo', 'latest', 'releases'])
    assert.ok(!Number.isNaN(Date.parse(data.generatedAt)), 'generatedAt is an ISO time')
    assert.equal(data.repo, REPO)
    assert.equal(data.latest, 'v0.3.0')
    assert.deepEqual(data.releases[1], expected030(`${apiBase}/download`))
    assert.deepEqual(Object.keys(data.releases[1]), ['tag', 'version', 'name', 'publishedAt', 'prerelease', 'url', 'notes', 'installer'])
    assert.deepEqual(Object.keys(data.releases[1].installer), ['name', 'url', 'bytes', 'sha256', 'sumsUrl'])
    assert.equal(data.releases[3].installer.sumsUrl, null)
    assert.equal(data.releases[3].installer.sha256, SHA_010)
    assert.ok(!data.releases.some((r) => r.tag === 'v0.4.0'), 'the draft is not listed')

    // What the fake API saw: the list with the token, then the sums without it.
    const mine = requests.slice(first)
    assert.deepEqual(
      mine.map((r) => r.url),
      [`/repos/${REPO}/releases?per_page=100`, '/download/v0.2.0/SHA256SUMS.txt', '/download/v0.3.0/SHA256SUMS.txt']
    )
    assert.equal(mine[0].headers.authorization, 'Bearer test-token')
    assert.equal(mine[0].headers.accept, 'application/vnd.github+json')
    assert.equal(mine[0].headers['x-github-api-version'], '2022-11-28')
    assert.equal(mine[0].headers['user-agent'], 'PromptFixer-site-releases')
    assert.equal(mine[1].headers.authorization, undefined)
  } finally {
    done()
  }
})
