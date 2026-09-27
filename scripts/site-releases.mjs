#!/usr/bin/env node
/**
 * Write site/releases.json, the release list the GitHub Pages site (site/)
 * shows and links: every published release of the repository, newest first,
 * with its notes and, for each, the Windows installer's name, size, SHA-256
 * and download link. The releases themselves are the source of truth, so the
 * file is generated at deploy time (.github/workflows/pages.yml) and
 * git-ignored: a committed copy would be stale the moment a draft is published.
 *
 *   node scripts/site-releases.mjs                     write site/releases.json for the repository in package.json
 *   node scripts/site-releases.mjs --out <file>        write elsewhere
 *   node scripts/site-releases.mjs --repo owner/name   another repository
 *
 * The list comes from the GitHub Releases API, with GITHUB_TOKEN or GH_TOKEN
 * when one is set (the workflow sets it; without one the API allows sixty
 * requests an hour, which is plenty). SITE_RELEASES_API_BASE replaces
 * https://api.github.com, for the tests. Drafts are left out. The installer's
 * hash is read from the release's SHA256SUMS.txt asset, or, when that asset or
 * its line is missing, from the "SHA-256 `...`" line of the release notes.
 *
 * Exits 1 and writes nothing when the API cannot be read, when a release's
 * SHA256SUMS.txt cannot be fetched or when there is no published release at
 * all: a stale file on the site is better than a broken or empty list, and the
 * workflow must fail loudly rather than deploy one. Usage errors exit 2.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const USAGE = 'usage: site-releases.mjs [--out <file>] [--repo owner/name]'
export const API_BASE = 'https://api.github.com'
export const OUT_FILE = 'site/releases.json'

/** The one asset the site offers for download; the .blockmap beside it is electron-builder's. */
const INSTALLER = /^PromptFixer-.+-win-x64\.exe$/
const SUMS_FILE = 'SHA256SUMS.txt'
/** One line of SHA256SUMS.txt as scripts/release-checksums.js writes it; "*" marks binary mode in sha256sum's own output. */
const SUMS_LINE = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/
/** The hash as the Release workflow writes it into the notes. */
const BODY_HASH = /SHA-256 `([0-9a-f]{64})`/
/** The Download/Verify block the Release workflow appends to the notes starts at this line. */
const SEPARATOR = '---'
/** github.com in the https, git+https, ssh and git+ssh spellings package.json may carry. */
const GITHUB_REPO = /github\.com[/:]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i

/**
 * "owner/name" from a package.json repository URL, or null for anything that
 * is not a GitHub repository. The API wants the bare pair; package.json holds
 * whatever `npm init` or a hand wrote, so every spelling is accepted.
 */
export function repoFromPackage(url) {
  const m = GITHUB_REPO.exec(typeof url === 'string' ? url.trim() : '')
  return m ? `${m[1]}/${m[2]}` : null
}

/** The hash of each file listed in SHA256SUMS.txt, by file name, lowercase; a line that is not one is skipped. */
export function parseSums(text) {
  const sums = new Map()
  for (const line of (text ?? '').split(/\r?\n/)) {
    const m = SUMS_LINE.exec(line)
    if (m) sums.set(m[2], m[1].toLowerCase())
  }
  return sums
}

/**
 * The release notes without the download block: everything before the first
 * line that is exactly "---", trimmed, with LF line endings (the API returns
 * what the editor on GitHub saved, which is CRLF). The facts of that block
 * live in the "installer" field, where the page can lay them out; the notes
 * proper are left as the markdown they are. A "---" inside a line is not the
 * separator. The whole body is returned when there is no separator (0.1.0 was
 * written by hand).
 */
export function splitNotes(body) {
  const lines = (body ?? '').replace(/\r\n?/g, '\n').split('\n')
  const cut = lines.findIndex((line) => line.trimEnd() === SEPARATOR)
  return (cut < 0 ? lines : lines.slice(0, cut)).join('\n').trim()
}

/** The hash the notes state, else null. */
export function hashFromBody(body) {
  return BODY_HASH.exec(body ?? '')?.[1] ?? null
}

/**
 * The Windows installer among a release's assets as `{ name, url, bytes }`,
 * or null. Only an asset in state "uploaded" counts: an upload that broke off
 * stays listed in another state and cannot be downloaded.
 */
export function installerOf(assets) {
  const asset = (assets ?? []).find((a) => a.state === 'uploaded' && INSTALLER.test(a.name))
  return asset ? { name: asset.name, url: asset.browser_download_url, bytes: asset.size } : null
}

/** The release's SHA256SUMS.txt asset, uploaded whole, or null. */
export function sumsAssetOf(assets) {
  return (assets ?? []).find((a) => a.state === 'uploaded' && a.name === SUMS_FILE) ?? null
}

const time = (release) => Date.parse(release.published_at ?? release.created_at ?? '') || 0

/**
 * The "releases" array and "latest" of site/releases.json from what the API
 * returned. `sumsByTag` maps a tag to the text of that release's
 * SHA256SUMS.txt (a Map or a plain object); a release without an entry, or
 * whose entry lacks the installer's line, gets the hash its notes state.
 * Drafts are dropped, the rest is ordered newest first. A pre-release is
 * listed and flagged but is never "latest": that is what a person who just
 * wants the app should download.
 */
export function toSiteReleases(apiReleases, { sumsByTag = new Map() } = {}) {
  const sumsOf = (tag) => (sumsByTag instanceof Map ? sumsByTag.get(tag) : sumsByTag?.[tag]) ?? null
  const releases = (apiReleases ?? [])
    .filter((r) => !r.draft)
    .sort((a, b) => time(b) - time(a))
    .map((r) => {
      const found = installerOf(r.assets)
      let installer = null
      if (found) {
        const sums = sumsAssetOf(r.assets)
        installer = {
          ...found,
          sha256: parseSums(sumsOf(r.tag_name)).get(found.name) ?? hashFromBody(r.body),
          sumsUrl: sums ? sums.browser_download_url : null,
        }
      }
      return {
        tag: r.tag_name,
        version: r.tag_name.replace(/^v/, ''),
        name: r.name || r.tag_name,
        publishedAt: r.published_at,
        prerelease: Boolean(r.prerelease),
        url: r.html_url,
        notes: splitNotes(r.body),
        installer,
      }
    })
  return { latest: releases.find((r) => !r.prerelease)?.tag ?? null, releases }
}

/** What every request to GitHub carries; the API refuses one without a User-Agent. */
function headers(token) {
  const h = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'PromptFixer-site-releases',
  }
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

/**
 * The response of a GET that answered 2xx; anything else is an Error naming
 * the URL and the status and what the body said, or, when no answer came at
 * all, the URL and why (fetch says "fetch failed" and keeps the reason in
 * `cause`, which a workflow log needs to see).
 */
async function get(url, { fetch, token }) {
  let res
  try {
    res = await fetch(url, { headers: headers(token), redirect: 'follow' })
  } catch (err) {
    const why = err.cause?.message ?? err.cause?.code
    throw new Error(`GET ${url}: ${err.message}${why ? ` (${why})` : ''}`)
  }
  if (res.ok) return res
  let detail = ''
  try {
    const text = await res.text()
    // The API explains itself in JSON ("API rate limit exceeded ..."); a proxy in HTML, which is not worth quoting.
    detail = JSON.parse(text)?.message ?? ''
  } catch {
    detail = ''
  }
  throw new Error(`GET ${url}: ${res.status} ${res.statusText}${detail ? ` (${detail})` : ''}`)
}

/**
 * Every release the API lists for `repo`, drafts included (the caller drops
 * them), as the API returned them. A body that is not a JSON array is as much
 * of a failure as a status that is not 2xx: nothing can be written from it.
 */
export async function fetchReleases(repo, { fetch = globalThis.fetch, apiBase = API_BASE, token = null } = {}) {
  // Each half encoded on its own: "owner/name" is two path segments, and a
  // character that is not a plain name must not become a query or another path.
  const [owner, name] = repo.split('/')
  const url = `${apiBase.replace(/\/+$/, '')}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases?per_page=100`
  const res = await get(url, { fetch, token })
  let releases
  try {
    releases = await res.json()
  } catch (err) {
    throw new Error(`GET ${url}: ${res.status} but the body is not JSON (${err.message})`)
  }
  if (!Array.isArray(releases)) throw new Error(`GET ${url}: ${res.status} but the body is not a list of releases`)
  return releases
}

/**
 * The whole of site/releases.json for `repo`: the API's list, the
 * SHA256SUMS.txt of every release that has an installer, and the time of
 * writing. `fetch` is a parameter so the tests can hand in a fake. The token
 * goes to the API only: a release asset is public, and its download redirects
 * to another host.
 */
export async function collectReleases(repo, { fetch = globalThis.fetch, apiBase = API_BASE, token = null } = {}) {
  const api = await fetchReleases(repo, { fetch, apiBase, token })
  const sumsByTag = new Map()
  for (const release of api) {
    if (release.draft || !installerOf(release.assets)) continue
    const sums = sumsAssetOf(release.assets)
    if (sums) sumsByTag.set(release.tag_name, await (await get(sums.browser_download_url, { fetch, token: null })).text())
  }
  const { latest, releases } = toSiteReleases(api, { sumsByTag })
  return { generatedAt: new Date().toISOString(), repo, latest, releases }
}

/** `{ out, repo }`, or `{ error }` for a command line that makes no sense. */
export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag !== '--out' && flag !== '--repo') return { error: `unknown argument: ${flag}` }
    const value = argv[++i]
    if (!value || value.startsWith('--')) return { error: `${flag} needs a value` }
    // GitHub's own alphabet for an owner and a repository name, so a value
    // like "../x" or "a/b?x=1" is refused here rather than sent to the API.
    if (flag === '--repo' && !/^[\w.-]+\/[\w.-]+$/.test(value)) return { error: `--repo wants owner/name, not ${value}` }
    out[flag.slice(2)] = value
  }
  return out
}

/** One line per release for the log, so a run's output says what the site will show. */
function describe(release) {
  const flag = release.prerelease ? ' (pre-release)' : ''
  const { installer } = release
  if (!installer) return `${release.tag}${flag}: no Windows installer`
  return `${release.tag}${flag}: ${installer.name}, ${installer.bytes} bytes, sha256 ${installer.sha256 ?? 'unknown'}`
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  if (args.error) {
    console.error(`${args.error}\n${USAGE}`)
    process.exit(2)
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  let repo = args.repo
  if (!repo) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    repo = repoFromPackage(typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url)
    if (!repo) {
      console.error('package.json names no GitHub repository; pass --repo owner/name')
      process.exit(2)
    }
  }
  const out = path.resolve(args.out ?? path.join(root, OUT_FILE))
  const apiBase = process.env.SITE_RELEASES_API_BASE || API_BASE
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null

  let data
  try {
    data = await collectReleases(repo, { apiBase, token })
  } catch (err) {
    console.error(`${err.message}\n${path.relative(process.cwd(), out) || out} is not written`)
    process.exit(1)
  }
  for (const release of data.releases) console.error(describe(release))
  if (data.releases.length === 0) {
    console.error(`${repo} has no published release; ${path.relative(process.cwd(), out) || out} is not written`)
    process.exit(1)
  }
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  console.log(`wrote ${path.relative(process.cwd(), out) || out}: ${data.releases.length} release(s) of ${repo}, latest ${data.latest ?? 'none'}`)
}
