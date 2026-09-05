/**
 * End-to-end check against a stub OpenAI-compatible provider.
 * Run with: npm test
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Ports are OS-assigned at runtime so two test runs (or a dev server) never collide.
let stubPort = 0
let BASE = '' // set once the server reports the port it was given

// Fresh, private directories per run: a PID-named dir can be inherited from an
// earlier run (PIDs are reused) and a fixed shared path can be populated by
// anything. Both are removed in after().
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptfixer-test-data-'))
const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptfixer-test-models-'))

// A key value nothing legitimate would ever echo back. If it shows up in any
// response body, a key has left the server.
const CANARY_KEY = 'canary-compatible-key-7f3a'

let stub
let server
let lastRequest = null
let lastAuthorization = null
/** Every /chat/completions call the stub saw, oldest first. */
const stubRequests = []

const FIX_RESPONSE = {
  fixedPrompt:
    'You are a senior content strategist.\n\n## Task\nWrite one blog post announcing our new feature.\n\n## Requirements\n- At most 600 words\n- Audience: [target audience]\n- Do not include statistics unless they are in the provided source material\n\n## Output format\nMarkdown, with an H1 title and three H2 sections.',
  summary: 'Split into labelled sections, bounded the length, and removed the conflicting brevity instruction.',
  changes: [
    { type: 'structure', what: 'Added labelled sections', why: 'Requirements buried in prose get ignored.' },
    { type: 'format', what: 'Capped length at 600 words', why: 'Prevents an unbounded wall of text.' },
    { type: 'context', what: 'Removed the ungrounded stats request', why: 'Avoids fabricated citations.' },
  ],
  assumptions: ['The post is for the company blog, not a press release.'],
  questions: ['Who is the target audience?', 'What is the feature called?'],
  techniques: ['output contract', 'sectioned prompt', 'grounding guard'],
}

/** What a small model did in the wild: ignored the input and wrote a different prompt. */
const DIVERGENT_RESPONSE = {
  ...FIX_RESPONSE,
  fixedPrompt:
    'Write a concise markdown table with columns name, risk, and fix. Return exactly 3 rows. Keep the output under 200 words.',
  summary: 'Added clear action, output format, length, and scope constraints to eliminate ambiguity.',
}

/** The original text with our instructions pasted after it. */
const leakedRewrite = (original) => ({
  ...FIX_RESPONSE,
  fixedPrompt: `${original.replace(/strgnth/g, 'strength')}\n\nSTRENGTH: LIGHT TOUCH. Correct spelling and grammar and fix only the findings listed below.\n\n<linter_findings>\n- [high/clarity] No clear action requested: no verb. → Open with the verb: Write...\n</linter_findings>\n\nReturn the JSON object now.`,
  summary: 'Applied light-touch edits.',
})

/** The faithful light-touch edit: one typo fixed, a full stop added. */
const typoFix = (original) => ({
  ...FIX_RESPONSE,
  fixedPrompt: original.replace(/strgnth/g, 'strength').replace(/\s*$/, '.'),
  summary: 'Fixed a typo.',
  changes: [{ type: 'clarity', what: 'Corrected "strgnth"', why: 'Typo.' }],
})

/** Every word kept, then a role and three sections bolted on. */
const bloatedRewrite = (original) => ({
  ...FIX_RESPONSE,
  fixedPrompt: `${original.replace(/strgnth/g, 'strength')}\n\n${FIX_RESPONSE.fixedPrompt}`,
  summary: 'Added structure.',
})

/**
 * The stub is strength-aware so the retention guard can be tested. Markers in
 * the original prompt pick a behaviour:
 *  - ALWAYS_DIVERGE: the divergent rewrite every time;
 *  - LEAK_ALWAYS / LEAK_ONCE: the text with our instructions pasted after it,
 *    every time / on the first attempt only;
 *  - DIVERGE_THEN_LEAK / LEAK_THEN_DIVERGE: one failure kind per attempt, so
 *    the attempt ranking is exercised;
 *  - BLOAT_ALWAYS / BLOAT_ONCE: every word kept plus 40 words of scaffolding;
 *  - otherwise light touch gets the divergent rewrite first and the faithful
 *    edit once the retry marker is present, and everything else gets
 *    FIX_RESPONSE, as before.
 */
function stubReply(request) {
  const user = request.messages?.[1]?.content || ''
  const original = user.match(/<original_prompt>\n([\s\S]*?)\n<\/original_prompt>/)?.[1] || ''
  const isRetry = user.includes('<rejected_attempt>')
  if (original.includes('ALWAYS_DIVERGE')) return DIVERGENT_RESPONSE
  // Another thing a small model did in the wild: kept the text but pasted our
  // instructions after it. LEAK_ONCE does it on the first attempt only.
  if (original.includes('LEAK_ALWAYS') || (original.includes('LEAK_ONCE') && !isRetry)) return leakedRewrite(original)
  if (original.includes('DIVERGE_THEN_LEAK')) return isRetry ? leakedRewrite(original) : DIVERGENT_RESPONSE
  if (original.includes('LEAK_THEN_DIVERGE')) return isRetry ? DIVERGENT_RESPONSE : leakedRewrite(original)
  if (original.includes('BLOAT_ALWAYS') || (original.includes('BLOAT_ONCE') && !isRetry)) return bloatedRewrite(original)
  if (user.includes('STRENGTH: LIGHT TOUCH')) {
    if (!isRetry) return DIVERGENT_RESPONSE
    return typoFix(original)
  }
  return FIX_RESPONSE
}

function startStub() {
  return new Promise((resolve) => {
    stub = http.createServer((req, res) => {
      if (req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'stub-large' }, { id: 'stub-small' }] }))
        return
      }
      if (req.url === '/chat/completions') {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          lastRequest = JSON.parse(body)
          lastAuthorization = req.headers.authorization || null
          const user = lastRequest.messages?.[1]?.content || ''
          const original = user.match(/<original_prompt>\n([\s\S]*?)\n<\/original_prompt>/)?.[1] || ''
          const isRetry = user.includes('<rejected_attempt>')
          const record = { original, isRetry, upstreamAborted: false }
          stubRequests.push(record)
          req.on('aborted', () => (record.upstreamAborted = true))

          const respond = () => {
            // RETRY_FAILS: the corrective retry gets a broken upstream — an
            // HTML error page where JSON was expected.
            if (original.includes('RETRY_FAILS') && isRetry) {
              res.writeHead(502, { 'content-type': 'text/html' })
              res.end('<html>Bad gateway</html>')
              return
            }
            const reply = stubReply(lastRequest)
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(
              JSON.stringify({
                model: lastRequest.model,
                choices: [{ message: { content: '```json\n' + JSON.stringify(reply) + '\n```' } }],
                usage: { prompt_tokens: 812, completion_tokens: 204 },
              })
            )
          }
          // SLOW: take long enough that a client can cancel mid-generation.
          if (original.includes('SLOW')) setTimeout(respond, 600)
          else respond()
        })
        return
      }
      res.writeHead(404)
      res.end('{}')
    })
    stub.listen(0, '127.0.0.1', () => {
      stubPort = stub.address().port
      resolve()
    })
  })
}

function startServer() {
  return new Promise((resolve, reject) => {
    let stderr = ''
    // Fail fast and loudly. Without this, a port already in use leaves the stub
    // server listening and the test runner never exits.
    let timer
    const fail = (message) => {
      clearTimeout(timer)
      stub?.close()
      reject(new Error(message))
    }
    const ready = () => {
      clearTimeout(timer)
      resolve()
    }
    server = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
      env: {
        ...process.env,
        PORT: '0',
        COMPATIBLE_BASE_URL: `http://127.0.0.1:${stubPort}`,
        COMPATIBLE_LABEL: 'Stub',
        COMPATIBLE_API_KEY: CANARY_KEY,
        DEFAULT_PROVIDER: 'compatible',
        ANTHROPIC_API_KEY: '',
        OPENAI_API_KEY: '',
        OPENROUTER_API_KEY: '',
        GOOGLE_API_KEY: '',
        // The developer's .env and shell must not steer the server under test.
        DEFAULT_MODEL: '',
        OLLAMA_BASE_URL: '',
        PROMPTFIXER_MODEL: '',
        PROMPTFIXER_PRELOAD: '0',
        PROMPTFIXER_DESKTOP: '0',
        // An empty models dir so "model missing" assertions hold regardless of
        // what this machine has downloaded.
        PROMPTFIXER_MODEL_DIR: modelDir,
        // A private library per test run, so a dev server or a second test
        // process writing to server/data/library.json can never flake this.
        PROMPTFIXER_DATA_DIR: dataDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    server.stdout.on('data', (d) => {
      stdout += d
      // The server prints the port it actually got (we asked for 0).
      const m = stdout.match(/PromptFixer API\s+→\s+http:\/\/localhost:(\d+)/)
      if (m) {
        BASE = `http://127.0.0.1:${m[1]}`
        ready()
      }
    })
    server.stderr.on('data', (d) => {
      stderr += d
      process.stderr.write(`[server] ${d}`)
    })
    server.on('error', (err) => fail(err.message))
    server.on('exit', (code) =>
      fail(
        `server exited with code ${code} before it was ready.\n` +
          (stderr.includes('EADDRINUSE')
            ? 'A port was already in use even though the OS assigned it — retry.'
            : stderr.slice(0, 600))
      )
    )
    timer = setTimeout(() => fail('server did not start within 15s'), 15000)
  })
}

const req = async (method, path_, body) => {
  const res = await fetch(BASE + path_, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  // Keys must never leave the server, whatever the route or status.
  assert.ok(!text.includes(CANARY_KEY), `API key leaked into ${method} ${path_}: ${text.slice(0, 200)}`)
  return { status: res.status, body: JSON.parse(text) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

before(async () => {
  await startStub()
  await startServer()
})

after(async () => {
  if (server && server.exitCode === null) {
    await new Promise((resolve) => {
      server.once('exit', resolve)
      server.kill()
    })
  }
  stub?.close()
  for (const dir of [dataDir, modelDir]) {
    // Windows can still hold a just-killed child's files open for a moment.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    assert.ok(!fs.existsSync(dir), `${dir} should be removed after the run`)
  }
})

test('GET /api/config lists providers and presets', async () => {
  const { status, body } = await req('GET', '/api/config')
  assert.equal(status, 200)
  assert.ok(body.providers.length >= 5)
  const stubProvider = body.providers.find((p) => p.id === 'compatible')
  assert.equal(stubProvider.configured, true, 'stub provider should be configured')
  assert.ok(body.presets.intents.length > 0)
  assert.ok(body.categories.clarity.label)
  // The key is configured (the stub sees it) but only its env name is exposed.
  assert.equal(stubProvider.keyEnv, 'COMPATIBLE_API_KEY')
  assert.ok(!JSON.stringify(body).includes(CANARY_KEY), 'API key leaked into /api/config')
})

test('GET /api/models reads the live list from the provider', async () => {
  const { status, body } = await req('GET', '/api/models?provider=compatible')
  assert.equal(status, 200)
  assert.equal(body.source, 'live')
  assert.deepEqual(body.models, ['stub-large', 'stub-small'])
})

test('GET /api/models reports a missing key instead of guessing', async () => {
  const { status, body } = await req('GET', '/api/models?provider=anthropic')
  assert.equal(status, 400)
  assert.match(body.error, /needs an API key/)
})

test('POST /api/analyze scores without touching a provider', async () => {
  const { status, body } = await req('POST', '/api/analyze', {
    prompt: 'write something good',
  })
  assert.equal(status, 200)
  assert.ok(body.analysis.score < 60, `expected a low score, got ${body.analysis.score}`)
  assert.ok(body.analysis.issues.some((i) => i.id === 'too-short'))
})

test('POST /api/analyze handles an empty prompt', async () => {
  const { status, body } = await req('POST', '/api/analyze', { prompt: '   ' })
  assert.equal(status, 200)
  assert.equal(body.analysis.empty, true)
  assert.equal(body.analysis.score, 0)
})

test('POST /api/analyze rejects an oversized prompt with 413, like /api/fix', async () => {
  const cfg = await req('GET', '/api/config')
  const limit = cfg.body.limits.maxPromptChars
  const prompt = 'the text below ' + '<a> '.repeat(Math.ceil((limit + 1000) / 4))
  const analyze = await req('POST', '/api/analyze', { prompt })
  assert.equal(analyze.status, 413)
  assert.match(analyze.body.error, /too long/)
  const fix = await req('POST', '/api/fix', { prompt, provider: 'compatible' })
  assert.equal(fix.status, 413)
})

test('non-object options and repeated query params are coerced, never a 500', async () => {
  for (const options of [null, 'light', 7, ['light'], true]) {
    const analyze = await req('POST', '/api/analyze', { prompt: 'write something good', options })
    assert.equal(analyze.status, 200, `analyze with options=${JSON.stringify(options)}`)
    assert.ok(analyze.body.analysis.score >= 0)
  }
  const fix = await req('POST', '/api/fix', {
    prompt: 'write a blog post about our new feature',
    provider: 'compatible',
    model: 'stub-large',
    options: null,
  })
  assert.equal(fix.status, 200)
  assert.equal(fix.body.meta.options.strength, 'balanced')

  // `?baseUrl=a&baseUrl=b` parses to an array and `?baseUrl[x]=1` to an object.
  for (const query of ['baseUrl=a&baseUrl=b', 'baseUrl[x]=1']) {
    const { status } = await req('GET', `/api/models?provider=compatible&${query}`)
    assert.ok(status < 500, `${query} answered ${status}`)
  }
})

test('POST /api/fix rewrites, re-scores, and reports changes', async () => {
  const original =
    'write a blog post about our new feature, make it good and professional. keep it brief but comprehensive, and cite some stats about the latest AI trends!!'
  const { status, body } = await req('POST', '/api/fix', {
    prompt: original,
    provider: 'compatible',
    model: 'stub-large',
    options: { intent: 'writing', targetModel: 'claude', strength: 'balanced', notes: 'keep it short' },
  })

  assert.equal(status, 200)
  assert.equal(body.original, original)
  assert.equal(body.fixedPrompt, FIX_RESPONSE.fixedPrompt)
  assert.equal(body.changes.length, 3)
  assert.deepEqual(body.questions, FIX_RESPONSE.questions)
  assert.ok(body.after.score > body.before.score, 'rewrite should score higher than the original')
  assert.equal(body.meta.model, 'stub-large')
  assert.equal(body.meta.usage.inputTokens, 812)
  // The key reached the provider as a bearer token, and nowhere else.
  assert.equal(lastAuthorization, `Bearer ${CANARY_KEY}`)
  // Balanced floor is 30%; this fixture keeps ~38%, so no retry and no warning.
  assert.equal(body.meta.attempts, 1)
  assert.equal(body.meta.warning, undefined)
  assert.equal(body.meta.warningKind, undefined)
  assert.ok(body.meta.retention >= 0.3)
  // The fixture rewrite contains "[target audience]": in the after-lint that is a
  // low-severity reminder, not the high-severity defect it is in an original.
  assert.equal(body.after.issues.find((i) => i.id === 'placeholders')?.severity, 'low')
  assert.equal(body.before.issues.find((i) => i.id === 'placeholders'), undefined)

  // The meta-prompt must carry the linter findings and the user's notes through.
  const sent = lastRequest.messages
  assert.match(sent[0].content, /prompt engineer/i)
  assert.match(sent[0].content, /Claude follows XML-ish tags/)
  assert.match(sent[1].content, /<linter_findings>/)
  assert.match(sent[1].content, /Conflicting instructions/)
  assert.match(sent[1].content, /keep it short/)
  assert.match(sent[1].content, /<original_prompt>/)
})

test('POST /api/fix ignores a client-supplied baseUrl', async () => {
  // The UI never sends one; honouring it would let any caller point the
  // server's stored key at a host of their choosing.
  const { status, body } = await req('POST', '/api/fix', {
    prompt: 'write a blog post about our new feature',
    provider: 'compatible',
    model: 'stub-large',
    baseUrl: 'http://127.0.0.1:1/nowhere',
  })
  assert.equal(status, 200, body.error)
  assert.equal(body.fixedPrompt, FIX_RESPONSE.fixedPrompt, 'the configured stub answered, not the supplied host')
})

test('POST /api/fix rejects an empty prompt', async () => {
  const { status, body } = await req('POST', '/api/fix', { prompt: '', provider: 'compatible' })
  assert.equal(status, 400)
  assert.match(body.error, /No prompt/)
})

test('POST /api/fix surfaces an unknown provider cleanly', async () => {
  const { status, body } = await req('POST', '/api/fix', { prompt: 'hello there', provider: 'nope' })
  assert.equal(status, 400)
  assert.match(body.error, /Unknown provider/)
})

test('library round-trips a save, search and delete', async () => {
  // A fresh data dir per run: nothing from an earlier run can be in here.
  const initial = await req('GET', '/api/library')
  assert.deepEqual(initial.body.entries, [], 'the library must start empty')

  const created = await req('POST', '/api/library', {
    original: 'raw prompt about widgets',
    fixed: 'polished prompt about widgets',
    scoreBefore: 41,
    scoreAfter: 92,
    model: 'stub-large',
  })
  assert.equal(created.status, 201)
  const { id, title } = created.body.entry
  assert.ok(id)
  assert.equal(title, 'raw prompt about widgets')

  const found = await req('GET', '/api/library?q=widgets')
  assert.ok(found.body.entries.some((e) => e.id === id))

  const missed = await req('GET', '/api/library?q=zzzznope')
  assert.equal(missed.body.entries.length, 0)

  const updated = await req('POST', '/api/library', { id, favorite: true })
  assert.equal(updated.body.entry.favorite, true)
  assert.equal(updated.body.entry.fixed, 'polished prompt about widgets', 'partial update must not wipe fields')

  const removed = await req('DELETE', `/api/library/${id}`)
  assert.equal(removed.body.removed, true)
  const emptied = await req('GET', '/api/library')
  assert.deepEqual(emptied.body.entries, [])
  assert.ok(fs.existsSync(path.join(dataDir, 'library.json')), 'the library lives in the per-run data dir')
})

test('GET /api/examples serves the eight demo prompts', async () => {
  const { status, body } = await req('GET', '/api/examples')
  assert.equal(status, 200)
  assert.equal(body.examples.length, 8)
  const ids = body.examples.map((e) => e.id)
  assert.equal(new Set(ids).size, 8, 'ids must be unique')
  for (const e of body.examples) {
    assert.match(e.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${e.id} should be kebab-case`)
    for (const key of ['name', 'useCase', 'prompt', 'intent', 'strength', 'expected']) {
      assert.equal(typeof e[key], 'string', `${e.id}.${key}`)
      assert.ok(e[key].trim(), `${e.id}.${key} must not be empty`)
    }
  }
  // The built-in sample the UI already knows is one of them, with the same text.
  const blog = body.examples.find((e) => e.id === 'blog-post-with-conflicting-instructions')
  assert.equal(blog.intent, 'writing')
  assert.match(blog.prompt, /^write a blog post about our new feature/)
})

test('library export round-trips through import, skipping duplicates and malformed entries', async () => {
  try {
    const a = (await req('POST', '/api/library', { original: 'export me first', fixed: 'Exported first.', scoreBefore: 40, scoreAfter: 80 })).body.entry
    const b = (await req('POST', '/api/library', { original: 'export me second', fixed: 'Exported second.' })).body.entry

    // Raw fetch: the download header is part of the contract.
    const res = await fetch(BASE + '/api/library/export')
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-disposition'), /^attachment; filename="promptfixer-library-\d{4}-\d{2}-\d{2}\.json"$/)
    const exported = await res.json()
    assert.equal(exported.version, 1)
    assert.ok(!Number.isNaN(Date.parse(exported.exportedAt)), 'exportedAt must be an ISO date')
    assert.deepEqual(
      exported.entries.map((e) => e.id),
      [b.id, a.id]
    )
    assert.equal(exported.entries[1].fixed, 'Exported first.')

    // Importing the export back changes nothing: every id is already here.
    const same = await req('POST', '/api/library/import', { entries: exported.entries })
    assert.equal(same.status, 200)
    assert.deepEqual(same.body, { imported: 0, skipped: 2, total: 2 })

    // A file from another machine: one new entry, one duplicate, two malformed.
    const foreign = { ...a, id: 'from-another-machine', original: 'imported original', fixed: 'Imported fixed.', favorite: true }
    const mixed = await req('POST', '/api/library/import', {
      entries: [foreign, { ...a, fixed: 'must not overwrite' }, { title: 'no id' }, 'junk'],
    })
    assert.deepEqual(mixed.body, { imported: 1, skipped: 3, total: 3 })
    const after = await req('GET', '/api/library')
    assert.equal(after.body.entries.length, 3)
    const imported = after.body.entries.find((e) => e.id === 'from-another-machine')
    assert.equal(imported.fixed, 'Imported fixed.')
    assert.equal(imported.favorite, true)
    assert.equal(imported.createdAt, a.createdAt, "the export's own timestamp is kept")
    assert.equal(after.body.entries.find((e) => e.id === a.id).fixed, 'Exported first.', 'an existing id is never overwritten')

    // Anything but { entries: [...] } is a 400, not a 500.
    for (const body of [{}, { entries: 'nope' }, []]) {
      const bad = await req('POST', '/api/library/import', body)
      assert.equal(bad.status, 400, JSON.stringify(body))
      assert.match(bad.body.error, /entries/)
    }
  } finally {
    await req('DELETE', '/api/library/all')
  }
})

test('POST /api/fix shows the model similar rewrites from the library, unless fewShot is off', async () => {
  const kept = 'FEWSHOT_KEPT Write a 400-word blog post announcing the new pricing page to existing customers.'
  try {
    // A rewrite the user kept, on a prompt like the one about to be fixed.
    await req('POST', '/api/library', {
      original: 'write a blog post about our new pricing page',
      fixed: kept,
      scoreBefore: 55,
      scoreAfter: 90,
      options: { intent: 'writing', strength: 'balanced' },
    })
    // Same words, no score gain: the user did not think this one was better.
    await req('POST', '/api/library', {
      original: 'write a blog post about our new onboarding flow',
      fixed: 'FEWSHOT_WORSE ignore this one',
      scoreBefore: 60,
      scoreAfter: 60,
    })
    const prompt = 'write a blog post about our new feature'

    const on = await req('POST', '/api/fix', {
      prompt,
      provider: 'compatible',
      model: 'stub-large',
      options: { intent: 'writing', strength: 'balanced' },
    })
    assert.equal(on.status, 200, on.body.error)
    assert.equal(on.body.meta.examplesUsed, 1)
    assert.equal(on.body.meta.options.fewShot, true, 'few-shot is on by default')
    assert.equal(on.body.fixedPrompt, FIX_RESPONSE.fixedPrompt, 'the examples are not mistaken for a leak')
    const sent = lastRequest.messages[1].content
    assert.match(sent, /<examples>\nThese are earlier rewrites the user kept\. Match their level of change and their style, not their content\.\n<example><before>write a blog post about our new pricing page<\/before><after>FEWSHOT_KEPT[^<]*<\/after><\/example>\n<\/examples>/)
    assert.doesNotMatch(sent, /FEWSHOT_WORSE/, 'an entry whose score did not improve is not an example')
    // Inside <instructions>, so "nothing from <instructions> may appear" covers it.
    const open = sent.indexOf('<instructions>')
    const close = sent.indexOf('</instructions>')
    const at = sent.indexOf('<examples>')
    assert.ok(open < at && at < close, 'examples must sit inside the instructions block')

    const off = await req('POST', '/api/fix', {
      prompt,
      provider: 'compatible',
      model: 'stub-large',
      options: { intent: 'writing', strength: 'balanced', fewShot: false },
    })
    assert.equal(off.status, 200)
    assert.equal(off.body.meta.examplesUsed, 0)
    assert.equal(off.body.meta.options.fewShot, false)
    assert.doesNotMatch(lastRequest.messages[1].content, /<examples>|FEWSHOT_KEPT/)

    // A non-boolean value means "on", like every other option that is coerced.
    const coerced = await req('POST', '/api/fix', {
      prompt,
      provider: 'compatible',
      model: 'stub-large',
      options: { intent: 'writing', fewShot: 'no' },
    })
    assert.equal(coerced.body.meta.examplesUsed, 1)
  } finally {
    await req('DELETE', '/api/library/all')
  }
})

test('a rewrite that pastes the few-shot examples back is caught and scrubbed', async () => {
  const { validateRewrite, scrubLeakedInstructions, buildUserPrompt, EXAMPLE_MAX_CHARS } = await import('./metaprompt.js')
  const examples = [{ before: 'an earlier prompt', after: 'An earlier prompt, fixed.' }]
  const message = buildUserPrompt({ prompt: USER_SENTENCE, analysis: null, options: { strength: 'light' }, examples })
  const block = message.match(/<examples>[\s\S]*<\/examples>/)[0]
  const pasted = `${USER_SENTENCE}\n\n${block}`
  const check = validateRewrite(USER_SENTENCE, pasted, { strength: 'light' })
  assert.equal(check.leaked, true)
  assert.equal(scrubLeakedInstructions(pasted, USER_SENTENCE), USER_SENTENCE, 'the whole block goes, example bodies included')
  // A rewrite that wraps its own worked example in <example> tags is NOT a leak:
  // the Claude and extraction presets ask for exactly that. Only the <examples>
  // wrapper and its preamble sentence identify pasted library examples.
  assert.equal(validateRewrite(USER_SENTENCE, `${USER_SENTENCE}\n<example>x</example>`, { strength: 'light' }).leaked, false)
  assert.equal(
    validateRewrite(USER_SENTENCE, `${USER_SENTENCE}\nThese are earlier rewrites the user kept.`, { strength: 'light' }).leaked,
    true
  )
  // Long examples are clipped; empty ones are dropped rather than rendered as blanks.
  const long = buildUserPrompt({ prompt: 'x', analysis: null, examples: [{ before: 'b'.repeat(2000), after: 'a' }] })
  assert.ok(long.match(/<before>(.*?)<\/before>/)[1].length <= EXAMPLE_MAX_CHARS + 1)
  assert.doesNotMatch(buildUserPrompt({ prompt: 'x', analysis: null, examples: [] }), /<examples>/)
  assert.doesNotMatch(buildUserPrompt({ prompt: 'x', analysis: null }), /<examples>/)
})

// dist/ is gitignored and `npm test` has no build step, so this one only runs
// where the frontend has been built; the fallthrough below needs no build.
const distIndex = path.join(__dirname, '..', 'dist', 'index.html')
test(
  'serves the built frontend at /',
  { skip: fs.existsSync(distIndex) ? false : 'dist/index.html is missing — run `npm run build` first' },
  async () => {
    const res = await fetch(BASE + '/')
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.match(html, /<div id="root">/)
  }
)

test('an unknown /api route is a 404, not the frontend shell', async () => {
  const res = await fetch(BASE + '/api/does-not-exist')
  assert.equal(res.status, 404)
  assert.doesNotMatch(await res.text(), /<div id="root">/)
})

// --- local model -------------------------------------------------------------

test('local model status reports the catalog and a missing model', async () => {
  const { status, body } = await req('GET', '/api/local/status')
  assert.equal(status, 200)
  assert.equal(body.phase, 'missing')
  assert.equal(body.downloaded, false)
  assert.equal(body.loaded, false)
  assert.equal(body.catalog.length, 3)
  assert.ok(body.catalog.some((c) => c.recommended), 'one tier must be flagged recommended')
  assert.ok(body.catalog.every((c) => c.downloaded === false))
  assert.equal(body.progress.percent, 0)
  // Local shows up in the provider list, unconfigured until the model is on disk.
  const cfg = await req('GET', '/api/config')
  const localProvider = cfg.body.providers.find((p) => p.id === 'local')
  assert.ok(localProvider)
  assert.equal(localProvider.configured, false)
  assert.equal(localProvider.keyOptional, true)
})

test('POST /api/fix with the local provider fails cleanly when the model is missing', async () => {
  const { status, body } = await req('POST', '/api/fix', {
    prompt: 'write something good and short please',
    provider: 'local',
  })
  assert.equal(status, 400)
  assert.equal(body.code, 'MODEL_MISSING')
  assert.match(body.error, /not downloaded/)
})

test('local tier selection validates the tier id', async () => {
  const bad = await req('POST', '/api/local/select', { tier: 'enormous' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.code, 'BAD_TIER')

  const ok = await req('POST', '/api/local/select', { tier: 'lite' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.tier, 'lite')
  assert.equal(ok.body.model.label, 'Qwen2.5 1.5B Instruct')

  // Restore so later tests are not order-dependent.
  await req('POST', '/api/local/select', { tier: 'default' })
})

// --- retention guard ---------------------------------------------------------

const USER_SENTENCE = 'I have changed the strgnth to light touch but still changes a lot'

test('retention() measures how much of the original survives', async () => {
  const { retention } = await import('./metaprompt.js')
  assert.equal(retention(USER_SENTENCE, USER_SENTENCE), 1)
  assert.ok(retention(USER_SENTENCE, DIVERGENT_RESPONSE.fixedPrompt) < 0.2, 'unrelated text keeps almost nothing')
  assert.ok(
    retention(USER_SENTENCE, 'I have changed the strength to light touch but it still changes a lot.') >= 0.8,
    'a typo fix keeps almost everything'
  )
  assert.equal(retention('', 'anything'), 1, 'empty original is trivially retained')
})

test('retention() handles scripts written without spaces', async () => {
  const { retention, validateRewrite } = await import('./metaprompt.js')
  // Japanese: one clause, no spaces. An in-clause edit must not read as "the whole clause was dropped".
  const ja = '次の文章を要約してください'
  const jaEdit = '次の文章を3行で要約してください'
  assert.ok(retention(ja, jaEdit) >= 0.8, `a small in-clause edit keeps most of it, got ${retention(ja, jaEdit)}`)
  assert.equal(retention(ja, ja), 1)
  assert.ok(retention(ja, '猫について詩を書いてください') < 0.4, 'a different Japanese sentence keeps little')
  // Chinese with unrelated text appended is still fully retained.
  const zh = '请把下面的文章总结成三点'
  assert.equal(retention(zh, zh + ' Return it as bullets.'), 1)
  // Thai and mixed-script prompts behave the same way.
  const th = 'สรุปบทความด้านล่างนี้ให้สั้น'
  assert.ok(retention(th, 'สรุปบทความด้านล่างนี้ให้สั้นและชัดเจน') >= 0.8)
  assert.ok(retention('この AIモデル の説明を書いて', 'この AIモデル の詳しい説明を書いて') >= 0.7)
  assert.equal(validateRewrite(ja, jaEdit, { strength: 'light' }).ok, true, 'a light Japanese edit passes the light floor')
  // Latin text is untouched by the bigram path.
  assert.ok(retention(USER_SENTENCE, DIVERGENT_RESPONSE.fixedPrompt) < 0.2)
})

test('light touch retries once when the model rewrites too much, and keeps the faithful retry', async () => {
  const { status, body } = await req('POST', '/api/fix', {
    prompt: USER_SENTENCE,
    provider: 'compatible',
    model: 'stub-large',
    options: { intent: 'code', strength: 'light' },
  })
  assert.equal(status, 200)
  assert.equal(body.meta.attempts, 2)
  assert.equal(body.meta.minRetention, 0.6)
  assert.ok(body.meta.retention >= 0.6, `retention ${body.meta.retention} should clear the light floor`)
  assert.equal(body.meta.warning, undefined)
  assert.match(body.fixedPrompt, /strength to light touch/)
  assert.doesNotMatch(body.fixedPrompt, /markdown table/)
  // Token usage is summed across both attempts.
  assert.equal(body.meta.usage.inputTokens, 812 * 2)

  // The retry carried the directive and the rejected attempt back to the model.
  const sent = lastRequest.messages[1].content
  assert.match(sent, /STRENGTH: LIGHT TOUCH/)
  assert.match(sent, /<rejected_attempt>/)
  assert.match(sent, /markdown table/)
  assert.match(sent, /only \d+% of the user's words survived/)
  // Low retention is the one case where "change as little as possible" is the right redo.
  assert.match(sent, /change as little as possible/)
  // Instructions come first and the prompt to edit sits alone at the end.
  assert.ok(
    sent.indexOf('</instructions>') < sent.indexOf('\n<original_prompt>\n'),
    'the prompt to edit must come after the instructions block'
  )
  assert.match(sent, /never copy those examples/)
})

test('light touch warns when even the retry rewrites too much', async () => {
  const { status, body } = await req('POST', '/api/fix', {
    prompt: `ALWAYS_DIVERGE ${USER_SENTENCE}`,
    provider: 'compatible',
    model: 'stub-large',
    options: { strength: 'light' },
  })
  assert.equal(status, 200)
  assert.equal(body.meta.attempts, 2)
  assert.ok(body.meta.retention < 0.6)
  assert.match(body.meta.warning, /Light touch/)
  assert.match(body.meta.warning, /\d+% of your words survived/)
  assert.match(body.meta.warning, /try Balanced/)
  assert.equal(body.meta.warningKind, 'retention')
  // The result is still returned so the user can inspect it in the diff.
  assert.equal(body.fixedPrompt, DIVERGENT_RESPONSE.fixedPrompt)
})

test('the retention warning never advises the strength the user is already on', async () => {
  const { status, body } = await req('POST', '/api/fix', {
    prompt: `ALWAYS_DIVERGE ${USER_SENTENCE}`,
    provider: 'compatible',
    model: 'stub-large',
    options: { strength: 'balanced' },
  })
  assert.equal(status, 200)
  assert.equal(body.meta.warningKind, 'retention')
  assert.match(body.meta.warning, /"Balanced" allows/)
  assert.doesNotMatch(body.meta.warning, /try Balanced/)
  assert.match(body.meta.warning, /try Light touch/)
})

test('full rebuild has no retention floor', async () => {
  const { status, body } = await req('POST', '/api/fix', {
    prompt: `ALWAYS_DIVERGE ${USER_SENTENCE}`,
    provider: 'compatible',
    model: 'stub-large',
    options: { strength: 'aggressive' },
  })
  assert.equal(status, 200)
  assert.equal(body.meta.attempts, 1)
  assert.equal(body.meta.minRetention, 0)
  assert.equal(body.meta.warning, undefined)
  assert.equal(body.meta.warningKind, undefined)
})

test('a failed corrective retry returns the first attempt with a warning, not a 5xx', async () => {
  const { status, body } = await req('POST', '/api/fix', {
    prompt: `RETRY_FAILS ALWAYS_DIVERGE ${USER_SENTENCE}`,
    provider: 'compatible',
    model: 'stub-large',
    options: { strength: 'light' },
  })
  assert.equal(status, 200)
  assert.equal(body.meta.attempts, 2)
  assert.equal(body.fixedPrompt, DIVERGENT_RESPONSE.fixedPrompt)
  assert.equal(body.meta.warningKind, 'retention')
  assert.match(body.meta.warning, /words survived/)
  assert.match(body.meta.warning, /retry also failed/)
  // Only the successful attempt's usage is counted.
  assert.equal(body.meta.usage.inputTokens, 812)
})

test('cancelling a fix skips the corrective retry', async () => {
  const marker = 'SLOW ALWAYS_DIVERGE'
  const controller = new AbortController()
  const pending = fetch(BASE + '/api/fix', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: `${marker} ${USER_SENTENCE}`,
      provider: 'compatible',
      model: 'stub-large',
      options: { strength: 'light' },
    }),
    signal: controller.signal,
  }).catch((err) => err)
  // Wait until the stub has the first attempt in hand, then walk away.
  while (!stubRequests.some((r) => r.original.includes(marker))) await sleep(20)
  controller.abort()
  const outcome = await pending
  assert.equal(outcome.name, 'AbortError')
  // The first attempt is already running; give it time to finish and for a
  // retry (which must not happen) to have been issued.
  await sleep(1200)
  const seen = stubRequests.filter((r) => r.original.includes(marker))
  assert.equal(seen.length, 1, 'no retry may be sent once the client has gone')
  assert.equal(seen[0].isRetry, false)
  // The server is still healthy afterwards.
  const { status } = await req('GET', '/api/health')
  assert.equal(status, 200)
})

// --- growth ceiling ----------------------------------------------------------

test('validateRewrite() rejects a light touch that keeps every word and adds scaffolding', async () => {
  const { validateRewrite, maxWords, MAX_GROWTH } = await import('./metaprompt.js')
  const bloated = bloatedRewrite(USER_SENTENCE).fixedPrompt
  const light = validateRewrite(USER_SENTENCE, bloated, { strength: 'light' })
  assert.equal(light.ok, false)
  assert.equal(light.leaked, false)
  assert.ok(light.retention >= 0.9, 'every word survived, so retention alone would have passed it')
  assert.match(light.reasons.join(' '), /added \d+ words of scaffolding/)
  assert.equal(light.maxWords, maxWords(USER_SENTENCE, 'light'))

  // Balanced allows three times the original; full rebuild has no ceiling.
  const longer = `${USER_SENTENCE} ${USER_SENTENCE}`
  const longerBloated = bloatedRewrite(longer).fixedPrompt
  assert.equal(validateRewrite(longer, longerBloated, { strength: 'light' }).ok, false)
  assert.equal(validateRewrite(longer, longerBloated, { strength: 'balanced' }).ok, true)
  assert.equal(validateRewrite(USER_SENTENCE, bloated, { strength: 'aggressive' }).ok, true)
  assert.equal(maxWords(USER_SENTENCE, 'aggressive'), Infinity)
  assert.equal(MAX_GROWTH.aggressive, null)

  // A short prompt can still gain a sentence at light touch: max(1.5×, +20 words).
  assert.equal(maxWords('fix this', 'light'), 22)
  assert.equal(maxWords('w '.repeat(100).trim(), 'light'), 150)
  assert.equal(validateRewrite('fix this', 'Fix this function so it handles empty input.', { strength: 'light' }).ok, true)
})

test('light touch retries when the model bolts scaffolding onto the text, and keeps the faithful retry', async () => {
  const { status, body } = await req('POST', '/api/fix', {
    prompt: `BLOAT_ONCE ${USER_SENTENCE}`,
    provider: 'compatible',
    model: 'stub-large',
    options: { strength: 'light' },
  })
  assert.equal(status, 200)
  assert.equal(body.meta.attempts, 2)
  assert.equal(body.meta.warning, undefined)
  assert.doesNotMatch(body.fixedPrompt, /## Requirements/)
  assert.match(body.fixedPrompt, /strength to light touch/)
  // The retry named the problem and did not ask for the light-touch "change as little as possible".
  const sent = lastRequest.messages[1].content
  assert.match(sent, /words of scaffolding/)
  assert.match(sent, /drop the added sections/)
  assert.doesNotMatch(sent, /change as little as possible/)
})

test('a rewrite that grows past the ceiling twice is returned with a growth warning', async () => {
  const { status, body } = await req('POST', '/api/fix', {
    prompt: `BLOAT_ALWAYS ${USER_SENTENCE}`,
    provider: 'compatible',
    model: 'stub-large',
    options: { strength: 'light' },
  })
  assert.equal(status, 200)
  assert.equal(body.meta.attempts, 2)
  assert.equal(body.meta.warningKind, 'growth')
  assert.match(body.meta.warning, /"Light touch" allows/)
  assert.match(body.meta.warning, /\d+ words of scaffolding/)
  assert.match(body.fixedPrompt, /## Requirements/, 'the result is still shown for the diff')
})

// --- attempt ranking ---------------------------------------------------------

test('pickBest() prefers clean over diverged over leaked, then higher retention, then the first attempt', async () => {
  const { pickBest } = await import('./metaprompt.js')
  const mk = (ok, leaked, retention) => ({ result: {}, check: { ok, leaked, retention } })
  const clean = mk(true, false, 0.7)
  const diverged = mk(false, false, 0.1)
  const leaked = mk(false, true, 1)
  assert.equal(pickBest(diverged, clean), clean)
  assert.equal(pickBest(clean, diverged), clean)
  assert.equal(pickBest(diverged, leaked), diverged, 'a leak never beats an un-leaked attempt, whatever its retention')
  assert.equal(pickBest(leaked, diverged), diverged)
  const divergedMore = mk(false, false, 0.3)
  assert.equal(pickBest(diverged, divergedMore), divergedMore, 'ties go to the attempt that kept more words')
  assert.equal(pickBest(divergedMore, diverged), divergedMore)
  assert.equal(pickBest(diverged, mk(false, false, 0.1)), diverged, 'an exact tie keeps the first attempt')
  assert.equal(pickBest(diverged, undefined), diverged, 'no second attempt means the first stands')
})

test('a divergent first attempt beats a leaked retry, and a leaked first attempt loses to a divergent retry', async () => {
  const first = await req('POST', '/api/fix', {
    prompt: `DIVERGE_THEN_LEAK ${USER_SENTENCE}`,
    provider: 'compatible',
    model: 'stub-large',
    options: { strength: 'light' },
  })
  assert.equal(first.status, 200)
  assert.equal(first.body.meta.attempts, 2)
  assert.equal(first.body.fixedPrompt, DIVERGENT_RESPONSE.fixedPrompt)
  assert.equal(first.body.meta.warningKind, 'retention')
  assert.match(first.body.meta.warning, /words survived/)
  assert.doesNotMatch(first.body.meta.warning, /copied/)

  const second = await req('POST', '/api/fix', {
    prompt: `LEAK_THEN_DIVERGE ${USER_SENTENCE}`,
    provider: 'compatible',
    model: 'stub-large',
    options: { strength: 'light' },
  })
  assert.equal(second.status, 200)
  assert.equal(second.body.meta.attempts, 2)
  assert.equal(second.body.fixedPrompt, DIVERGENT_RESPONSE.fixedPrompt)
  assert.equal(second.body.meta.warningKind, 'retention')
  assert.doesNotMatch(second.body.fixedPrompt, /STRENGTH:|linter_findings/)
})

// --- leaked instructions -----------------------------------------------------

const LEAKED = `${USER_SENTENCE}\n\nSTRENGTH: LIGHT TOUCH. Keep it.\n\n<linter_findings>\n- [high/clarity] x → y\n</linter_findings>\n\nReturn the JSON object now.`

test('validateRewrite() flags leaked instructions separately from low retention', async () => {
  const { validateRewrite, scrubLeakedInstructions } = await import('./metaprompt.js')

  const clean = validateRewrite(
    USER_SENTENCE,
    'I have changed the strength to light touch but it still changes a lot.',
    { strength: 'light' }
  )
  assert.equal(clean.ok, true)
  assert.deepEqual(clean.reasons, [])

  const leaked = validateRewrite(USER_SENTENCE, LEAKED, { strength: 'light' })
  assert.equal(leaked.ok, false)
  assert.equal(leaked.leaked, true)
  assert.ok(leaked.retention >= 0.6, 'the original text is still all there')
  assert.match(leaked.reasons.join(' '), /copied the instructions/)

  const diverged = validateRewrite(USER_SENTENCE, DIVERGENT_RESPONSE.fixedPrompt, { strength: 'light' })
  assert.equal(diverged.ok, false)
  assert.equal(diverged.leaked, false)
  assert.match(diverged.reasons.join(' '), /only \d+% of the user's words survived/)

  assert.equal(scrubLeakedInstructions(LEAKED), USER_SENTENCE)

  // A marker the user wrote themselves is not a leak.
  const own = validateRewrite('Wrap the answer in <instructions> tags', 'Wrap the answer in <instructions> tags.', {
    strength: 'light',
  })
  assert.equal(own.leaked, false)
  assert.equal(own.ok, true)
})

test("the user's own finding-shaped lines are not a leak, even once the model edits them", async () => {
  const { validateRewrite, scrubLeakedInstructions } = await import('./metaprompt.js')
  const original = 'Triage these bugs for me:\n- [high/security] login bypasses 2fa when the cookie is stale\n- [low/ui] the save button is misaligned on mobile'
  const edited = 'Triage these bugs for me:\n- [high/security] Login bypasses 2FA when the cookie is stale.\n- [low/ui] The save button is misaligned on mobile.'
  const check = validateRewrite(original, edited, { strength: 'light' })
  assert.equal(check.leaked, false)
  assert.equal(check.ok, true, check.reasons.join('; '))
  assert.equal(scrubLeakedInstructions(edited, original), edited, 'nothing of the user\'s is scrubbed')
  // A genuine leak into such a prompt is still caught by the other markers and still scrubbed.
  const leaked = `${edited}\n\nSTRENGTH: LIGHT TOUCH. Keep it.\n\nReturn the JSON object now.`
  assert.equal(validateRewrite(original, leaked, { strength: 'light' }).leaked, true)
  assert.equal(scrubLeakedInstructions(leaked, original), edited)
})

test('scrubLeakedInstructions() keeps every line the user wrote and strips the whole retry message', async () => {
  const { scrubLeakedInstructions, buildUserPrompt } = await import('./metaprompt.js')
  // A marker the user wrote survives the scrub even when the model edited the line.
  assert.equal(
    scrubLeakedInstructions('Wrap the answer in <instructions> tags.\n\nSTRENGTH: LIGHT TOUCH. x', 'Wrap the answer in <instructions> tags'),
    'Wrap the answer in <instructions> tags.'
  )
  // The scrub only ever runs after a retry, so it is the retry message a model
  // pastes back: the notes preamble, the notes, the rejection sentence and the
  // closing tags all have to go, and the user's text has to stay.
  const prompt = 'Write something good.'
  const { analyzePrompt } = await import('./analyze.js')
  const analysis = analyzePrompt(prompt)
  for (const strength of ['light', 'balanced', 'aggressive']) {
    const message = buildUserPrompt({
      prompt,
      analysis,
      options: { strength, notes: 'keep my tone' },
      retry: { previous: 'A different prompt entirely.', reasons: ['it copied the instructions'] },
    })
    const out = scrubLeakedInstructions(`OK.\n\n${message}`, prompt)
    assert.doesNotMatch(out, /rejected|user added instructions|You will fix one prompt|keep my tone|static linter|different prompt entirely/, strength)
    assert.doesNotMatch(out, /<\/?(instructions|user_notes|original_prompt|rejected_attempt|linter_findings)>/, strength)
    assert.match(out, /^OK\.\n\nWrite something good\.$/, strength)
  }
})

test('the retry instruction respects the chosen strength', async () => {
  const { buildUserPrompt } = await import('./metaprompt.js')
  const base = { prompt: USER_SENTENCE, analysis: null }
  const leakRetry = { previous: LEAKED, reasons: ['it copied the instructions (the STRENGTH line) into fixedPrompt'] }
  const rebuild = buildUserPrompt({ ...base, options: { strength: 'aggressive' }, retry: leakRetry })
  assert.match(rebuild, /Your previous attempt was rejected/)
  assert.match(rebuild, /at the same strength/)
  assert.doesNotMatch(rebuild, /change as little as possible/, 'a full rebuild must not be told to make a light edit')
  // Only a retention failure asks for the light-touch redo.
  const retentionRetry = { previous: DIVERGENT_RESPONSE.fixedPrompt, reasons: ["only 10% of the user's words survived"] }
  assert.match(buildUserPrompt({ ...base, options: { strength: 'light' }, retry: retentionRetry }), /change as little as possible/)
  assert.match(buildUserPrompt({ ...base, options: { strength: 'balanced' }, retry: retentionRetry }), /change as little as possible/)
})

test('extractJson() finds the object after prose that contains braces', async () => {
  const { extractJson } = await import('./metaprompt.js')
  assert.equal(extractJson('I kept {{input}} as a placeholder.\n\n{"fixedPrompt":"x"}').fixedPrompt, 'x')
  assert.equal(extractJson('Here {a} and {b}: {"fixedPrompt":"y"}').fixedPrompt, 'y')
  assert.equal(extractJson('{"fixedPrompt":"z"} — done, {{input}} kept.').fixedPrompt, 'z')
  assert.equal(extractJson('```json\n{"fixedPrompt":"fenced"}\n```').fixedPrompt, 'fenced')
  assert.equal(extractJson('Sure:\n{"fixedPrompt":"a \\"quoted\\" {brace} inside"}\nThanks').fixedPrompt, 'a "quoted" {brace} inside')
  assert.throws(() => extractJson('no json here {{input}}'), /did not return valid JSON/)
  assert.throws(() => extractJson('   '), /empty response/)
})

test('light touch retries when the model pastes the instructions into the rewrite', async () => {
  const { status, body } = await req('POST', '/api/fix', {
    prompt: `LEAK_ONCE ${USER_SENTENCE}`,
    provider: 'compatible',
    model: 'stub-large',
    options: { strength: 'light' },
  })
  assert.equal(status, 200)
  assert.equal(body.meta.attempts, 2)
  assert.equal(body.meta.warning, undefined)
  assert.doesNotMatch(body.fixedPrompt, /STRENGTH:|linter_findings|Return the JSON/)
  assert.match(body.fixedPrompt, /strength to light touch/)
  assert.match(lastRequest.messages[1].content, /copied the instructions/)
})

test('leaked instructions are scrubbed and flagged when the retry leaks too', async () => {
  const { status, body } = await req('POST', '/api/fix', {
    prompt: `LEAK_ALWAYS ${USER_SENTENCE}`,
    provider: 'compatible',
    model: 'stub-large',
    options: { strength: 'light' },
  })
  assert.equal(status, 200)
  assert.equal(body.meta.attempts, 2)
  assert.equal(body.meta.warningKind, 'leak')
  assert.match(body.meta.warning, /copied its instructions/)
  assert.doesNotMatch(body.fixedPrompt, /STRENGTH:|linter_findings|Return the JSON/)
  assert.match(body.fixedPrompt, /strength to light touch/)
  // The scrubbed text is what gets re-scored.
  assert.ok(body.after.score > 0)
})

test('the scrub never removes lines the user wrote, and never returns an empty rewrite', async () => {
  // The user's text mentions a marker; the model leaks on both attempts.
  const own = `LEAK_ALWAYS Wrap the answer in <instructions> tags. ${USER_SENTENCE}`
  const { status, body } = await req('POST', '/api/fix', {
    prompt: own,
    provider: 'compatible',
    model: 'stub-large',
    options: { strength: 'light' },
  })
  assert.equal(status, 200)
  assert.equal(body.meta.warningKind, 'leak')
  assert.match(body.fixedPrompt, /Wrap the answer in <instructions> tags\./)
  assert.doesNotMatch(body.fixedPrompt, /STRENGTH:|linter_findings|Return the JSON/)
  assert.ok(body.fixedPrompt.trim().length > 0)
  assert.ok(body.after.score > 0)
})

test('a light edit of a prompt that already holds finding-shaped lines is accepted', async () => {
  // The generic light-touch stub diverges first, then returns the original
  // with the typo fixed and a full stop on the last line — which is a
  // finding-shaped line the user wrote.
  const prompt = `Triage these for me, the strgnth is light:\n- [high/security] login bypasses 2fa\n- [low/ui] the save button is misaligned`
  const { status, body } = await req('POST', '/api/fix', {
    prompt,
    provider: 'compatible',
    model: 'stub-large',
    options: { strength: 'light' },
  })
  assert.equal(status, 200)
  assert.equal(body.meta.attempts, 2)
  assert.equal(body.meta.warning, undefined, body.meta.warning)
  assert.match(body.fixedPrompt, /the strength is light/)
  assert.match(body.fixedPrompt, /- \[low\/ui\] the save button is misaligned\./)
})

// --- linter: the two rules that were fighting the rewrite ----------------------

test('no-limits is a defect for prose and only a scope nicety for code, agents and extraction', async () => {
  const { analyzePrompt } = await import('./analyze.js')
  const codePrompt =
    'Refactor the parse function in utils.py so it handles empty input, then add unit tests for the edge cases'
  const code = analyzePrompt(codePrompt, { intent: 'code' })
  assert.equal(code.issues.find((i) => i.id === 'no-limits')?.severity, 'low')
  assert.match(code.issues.find((i) => i.id === 'no-limits').suggestion, /scope/)

  const prosePrompt =
    'Write a blog post about remote work productivity for engineering managers who run distributed teams across time zones'
  const prose = analyzePrompt(prosePrompt, { intent: 'writing' })
  assert.equal(prose.issues.find((i) => i.id === 'no-limits')?.severity, 'medium')
  // The suggestion no longer hands the model a copyable "at most 200 words".
  assert.doesNotMatch(prose.issues.find((i) => i.id === 'no-limits').suggestion, /200 words/)

  for (const intent of ['agent', 'extraction', 'image']) {
    assert.equal(analyzePrompt(prosePrompt, { intent }).issues.find((i) => i.id === 'no-limits')?.severity, 'low', intent)
  }

  // Bounds the linter used to miss: hyphenated counts, number words, scope phrases.
  const bounded = [
    'You are a release manager writing for engineering leads. Write a 150-word launch note for the new offline mode, structured as: one-sentence summary, three bullet benefits, one known limitation.',
    'Refactor the parse() function in src/utils.py so it returns an empty list on empty input. Return only the changed function with a one-line docstring, no commentary.',
    'Summarise the attached incident report in five bullets for the on-call channel.',
    'List the top 3 risks in this migration plan as a table with columns risk, likelihood, mitigation.',
  ]
  for (const t of bounded) {
    assert.equal(analyzePrompt(t, { intent: 'writing' }).issues.find((i) => i.id === 'no-limits'), undefined, t)
  }
  assert.ok(
    analyzePrompt('Write a launch note for the new offline mode for engineering leads and explain the benefits', { intent: 'writing' }).issues.some((i) => i.id === 'no-limits'),
    'a genuinely unbounded prose prompt is still flagged'
  )
})

test('placeholders are a defect in an original and a reminder in a rewrite', async () => {
  const { analyzePrompt } = await import('./analyze.js')
  const text = 'Write a product description for [product name] aimed at [target audience], under 120 words.'
  const original = analyzePrompt(text, { intent: 'writing' })
  const rewrite = analyzePrompt(text, { intent: 'writing', rewrite: true })
  assert.equal(original.issues.find((i) => i.id === 'placeholders')?.severity, 'high')
  assert.equal(rewrite.issues.find((i) => i.id === 'placeholders')?.severity, 'low')
  assert.ok(rewrite.score > original.score, 'the same text must not be punished for honest placeholders in a rewrite')
  assert.deepEqual(rewrite.issues.find((i) => i.id === 'placeholders').evidence, ['[product name]', '[target audience]'])

  // Things that look bracketed but are not slots must not fire the rule.
  const notSlots = [
    'See the docs at [the guide](https://example.com) and cite [1] and [2].',
    'Logs look like [ERROR] connection refused and [INFO] retrying.',
    'Tick each item: - [x] done - [ ] pending',
  ]
  for (const t of notSlots) {
    assert.equal(analyzePrompt(t).issues.find((i) => i.id === 'placeholders'), undefined, t)
  }
  // {{variables}} are how a system prompt names its inputs — fine for the agent preset, flagged elsewhere.
  const sys = 'You are a support agent. Answer {{question}} using only {{context}}; if unsure, say so.'
  assert.equal(analyzePrompt(sys, { intent: 'agent' }).issues.find((i) => i.id === 'placeholders'), undefined)
  assert.equal(analyzePrompt(sys, { intent: 'general' }).issues.find((i) => i.id === 'placeholders')?.severity, 'high')
})

test('the system prompt forbids word counts on code and placeholder-only sentences', async () => {
  const { buildSystemPrompt } = await import('./metaprompt.js')
  const system = buildSystemPrompt({ intent: 'code', targetModel: 'generic', strength: 'balanced' })
  assert.match(system, /Never add a word count to a request for code/)
  assert.match(system, /Never write a sentence made only of placeholders/)
  assert.match(system, /Findings are advice, not orders/)
})

test('light touch never hands the model additive findings it could only satisfy by inventing', async () => {
  const { buildUserPrompt, ADDITIVE_FINDINGS } = await import('./metaprompt.js')
  const { analyzePrompt } = await import('./analyze.js')
  const prompt =
    'write a blog post about our new feature, make it good and professional. keep it brief but comprehensive, and cite some stats about the latest AI trends!!'
  const analysis = analyzePrompt(prompt, { intent: 'writing' })
  const ids = analysis.issues.map((i) => i.id)
  assert.ok(ids.some((id) => ADDITIVE_FINDINGS.has(id)), 'fixture must trigger at least one additive finding')

  const light = buildUserPrompt({ prompt, analysis, options: { strength: 'light' } })
  assert.match(light, /Conflicting instructions/, 'text-level findings still go through')
  for (const title of ['No background or context', 'No output format specified', 'Audience not identified', 'No length or scope limit', 'No role or perspective set']) {
    assert.doesNotMatch(light, new RegExp(title), `light touch must not see "${title}"`)
  }
  assert.match(light, /do not add any fact, number or context/)

  const balanced = buildUserPrompt({ prompt, analysis, options: { strength: 'balanced' } })
  assert.match(balanced, /No output format specified/, 'balanced keeps additive findings')

  // No linter suggestion hands the model a literal it can paste as content.
  for (const issue of analysis.issues) {
    assert.doesNotMatch(issue.suggestion, /200 words|name, risk, fix|hiring manager|March 2026/, issue.id)
  }
})
