import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cors from 'cors'
import 'dotenv/config'
import express from 'express'

import { CATEGORIES, analyzePrompt } from './analyze.js'
import { EXAMPLES } from './examples.js'
import * as local from './local-llm.js'
import {
  OUTPUT_SCHEMA,
  STRENGTHS,
  buildSystemPrompt,
  buildUserPrompt,
  collapseSpace,
  extractJson,
  nestedMarks,
  normalizeResult,
  partialStringField,
  passageStarts,
  pickBest,
  presets,
  scrubLeakedInstructions,
  STREAMED_FIELD,
  validateRewrite,
} from './metaprompt.js'
import { ProviderError, complete, listModels, providerStatus, redact } from './providers.js'
import * as store from './store.js'
import { VERSION } from './version.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// PORT=0 is valid (OS-assigned port), so don't treat 0 as "unset".
const PORT = process.env.PORT !== undefined && process.env.PORT !== '' ? Number(process.env.PORT) : 8787
const DEFAULT_PROVIDER = process.env.DEFAULT_PROVIDER || 'local'
const MAX_PROMPT_CHARS = 60_000

const app = express()
app.use(cors({ origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/] }))
app.use(express.json({ limit: '2mb' }))

const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)

/**
 * One line of a newline-delimited JSON reply. The route and the error handler
 * both write to the same stream, so the framing rule lives in one place.
 */
const writeEvent = (res, event) => {
  if (res.writableEnded) return
  res.write(`${JSON.stringify(event)}
`)
}

/**
 * The linter's regexes are not all linear, so the cap applies to every route
 * that runs it — one oversized /api/analyze body would otherwise block the
 * event loop for everyone.
 */
function boundedPrompt(body) {
  const prompt = typeof body?.prompt === 'string' ? body.prompt : ''
  if (prompt.length > MAX_PROMPT_CHARS) {
    const err = new Error(`Prompt is too long (${prompt.length} chars, limit ${MAX_PROMPT_CHARS}).`)
    err.status = 413
    throw err
  }
  return prompt
}

function requirePrompt(body) {
  const prompt = boundedPrompt(body)
  if (!prompt.trim()) {
    const err = new Error('No prompt provided.')
    err.status = 400
    throw err
  }
  return prompt
}

/** Only these fields are accepted from the client; everything else is ignored. */
function readOptions(raw) {
  // `null`, an array or a string are not option bags; treat them as empty
  // rather than letting a property read throw a 500.
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    intent: String(o.intent || 'general'),
    targetModel: String(o.targetModel || 'generic'),
    strength: String(o.strength || 'balanced'),
    preserveTone: !!o.preserveTone,
    includeExample: !!o.includeExample,
    addRole: !!o.addRole,
    notes: typeof o.notes === 'string' ? o.notes.slice(0, 2000) : '',
    // On unless the client says otherwise: an older UI that never sends the
    // field still gets the benefit of its own library.
    fewShot: typeof o.fewShot === 'boolean' ? o.fewShot : true,
  }
}

const MAX_MARKS = 20
const MAX_MARK_CHARS = 2000

/**
 * The marks a user put on an earlier rewrite, as `{ previous, keep, change }`,
 * or null when nothing usable was sent — the request is then an ordinary fix.
 * Coerced like readOptions(): a malformed field is dropped, never a 500.
 */
function readFeedback(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const previous = typeof raw.previous === 'string' ? raw.previous : ''
  // It goes to the model next to the prompt, so it gets the prompt's cap.
  if (previous.length > MAX_PROMPT_CHARS) {
    const err = new Error(`The marked rewrite is too long (${previous.length} chars, limit ${MAX_PROMPT_CHARS}).`)
    err.status = 413
    throw err
  }
  if (!previous.trim()) return null

  const flatPrevious = collapseSpace(previous)
  // `usable` has the last word on a passage, before it counts towards the cap.
  const passages = (value, usable = () => true, cap = MAX_MARKS) => {
    const seen = new Set()
    const out = []
    // Only the head of the list is read, and no further than the cap: every
    // item costs a search through the rewrite, and a 2 MB body holds a great many.
    for (const item of (Array.isArray(value) ? value : []).slice(0, MAX_MARKS * 2)) {
      if (out.length === cap) break
      if (typeof item !== 'string') continue
      const text = item.trim().slice(0, MAX_MARK_CHARS).trim()
      const flat = collapseSpace(text)
      if (!flat || seen.has(flat)) continue
      seen.add(flat)
      // A mark has to point at something in the rewrite it was made on. Every
      // place it could sit counts, overlapping ones too: the user marked one.
      const at = passageStarts(flatPrevious, flat, true)
      const mark = { text, first: at[0], last: at[at.length - 1], length: flat.length }
      if (at.length && usable(mark)) out.push(mark)
    }
    return out
  }
  const change = passages(raw.change)
  // The interface marks places; what arrives is their text. "Keep this" and
  // "change this" only contradict each other when no two places they could
  // stand for lie apart — the same words where they occur once, a keep that
  // only exists inside the passage to change, a change whose every occurrence
  // runs into the keep. Then the change wins: a complaint is the more specific
  // of the two. Words disliked in one place and kept inside a sentence
  // somewhere else are two marks, and the model is told which wins where.
  const apart = (a, b) => a.first + a.length <= b.last || b.first + b.length <= a.last
  const changed = change.map((m) => m.text)
  const kept = passages(raw.keep, (k) => change.every((c) => apart(k, c)), MAX_MARKS * 2).map((m) => m.text)
  // Apart from each kept passage is not yet apart from all of them: words that
  // stand nowhere but inside kept passages, none of which stands anywhere else,
  // leave the model no place to change (the interface cannot send this; its
  // marks never overlap). There the change wins too, over as few keeps as will
  // do — and like the others, the ones that lose do not use up the cap.
  const { stuck } = nestedMarks({ previous, keep: kept, change: changed })
  const keep = kept.filter((k) => !stuck.includes(k)).slice(0, MAX_MARKS)
  return keep.length || change.length ? { previous, keep, change: changed } : null
}

// --- meta --------------------------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, version: VERSION })
})

app.get('/api/config', (_req, res) => {
  res.json({
    // The interface reads this once at startup and shows it beside the name,
    // so a bug report names the build it came from. Same source as
    // /api/health: package.json, the one place the version is written down.
    version: VERSION,
    providers: providerStatus(),
    defaultProvider: DEFAULT_PROVIDER,
    desktop: process.env.PROMPTFIXER_DESKTOP === '1',
    defaultModel: process.env.DEFAULT_MODEL || '',
    categories: CATEGORIES,
    presets: presets(),
    limits: { maxPromptChars: MAX_PROMPT_CHARS },
  })
})

app.get('/api/examples', (_req, res) => {
  res.json({ examples: EXAMPLES })
})

app.get(
  '/api/models',
  wrap(async (req, res) => {
    const providerId = String(req.query.provider || '')
    // `?baseUrl=a&baseUrl=b` parses to an array; anything but a string is ignored.
    const baseUrl = typeof req.query.baseUrl === 'string' ? req.query.baseUrl : undefined
    const result = await listModels(providerId, { baseUrl })
    res.json(result)
  })
)

// --- analysis ----------------------------------------------------------------

app.post(
  '/api/analyze',
  wrap(async (req, res) => {
    const prompt = boundedPrompt(req.body)
    const options = readOptions(req.body?.options)
    res.json({
      analysis: analyzePrompt(prompt, {
        intent: options.intent,
        addRole: options.addRole,
        includeExample: options.includeExample,
      }),
    })
  })
)

// --- the main event ----------------------------------------------------------

app.post(
  '/api/fix',
  wrap(async (req, res) => {
    const prompt = requirePrompt(req.body)
    const options = readOptions(req.body?.options)
    // Set on a "fix again": the user marked up an earlier rewrite. `prompt` is
    // still the original, so scores, diff and guard measure against that.
    const feedback = readFeedback(req.body?.feedback)
    const providerId = String(req.body?.provider || DEFAULT_PROVIDER)
    const model = req.body?.model ? String(req.body.model) : process.env.DEFAULT_MODEL || ''

    // Same lint options before and after, so the two scores are comparable.
    const lintOptions = {
      intent: options.intent,
      addRole: options.addRole,
      includeExample: options.includeExample,
    }
    const before = analyzePrompt(prompt, lintOptions)

    const system = buildSystemPrompt(options)
    const strengthLabel = STRENGTHS.find((s) => s.id === options.strength)?.label || options.strength

    // Few-shot from the user's own library: the rewrites they kept show the
    // model what "enough change" looks like for them. Looked up once, before
    // the first attempt, so a retry sees the same examples.
    const examples = options.fewShot
      ? (await store.similar(prompt, { intent: options.intent, limit: 2 })).map((e) => ({
          before: e.original,
          after: e.fixed,
        }))
      : []

    const started = Date.now()
    const usage = { inputTokens: 0, outputTokens: 0 }
    let attempts = 0
    let modelName = ''

    // When the client cancels, stop the generation too: the local model would
    // otherwise keep the GPU busy and the next Fix would queue behind it.
    // `close` also fires after a normal response, hence the finished check.
    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) controller.abort()
    })

    // Streaming is opt-in by Accept header: an older client, a script or curl
    // still gets exactly the single JSON body it got before. Events are one
    // JSON object per line — no framing to get wrong, and readable in a
    // terminal. The error middleware finishes the stream if anything throws.
    const streaming = String(req.headers.accept || '').includes('application/x-ndjson')
    const send = (event) => {
      if (streaming) writeEvent(res, event)
    }
    if (streaming) {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      // A proxy that buffers would undo the whole point of streaming.
      res.setHeader('X-Accel-Buffering', 'no')
      res.flushHeaders()
    }

    const attempt = async (retry) => {
      if (controller.signal.aborted) {
        const err = new Error('The request was cancelled.')
        err.status = 499
        throw err
      }
      attempts++
      const which = attempts
      // A retry rewrites from scratch, so the client is told to clear what it
      // has already shown rather than append the second attempt to the first.
      send({ type: 'attempt', attempt: which })

      // The grammar emits fixedPrompt first, so the rewrite can be read out of
      // the reply while the rest of the JSON is still being written. Only the
      // part not yet sent goes on the wire; the reader never goes backwards.
      let raw = ''
      let sent = 0
      // Not `complete`: that is the provider function imported at the top.
      let rewriteDone = false
      const onTextChunk = streaming
        ? (chunk) => {
            if (rewriteDone) return
            raw += chunk
            const seen = partialStringField(raw, STREAMED_FIELD)
            if (!seen) return
            if (seen.text.length > sent) {
              send({ type: 'delta', attempt: which, text: seen.text.slice(sent) })
              sent = seen.text.length
            }
            // The rest of the reply cannot extend the rewrite, and every scan
            // walks the whole field, so stop once it is closed.
            rewriteDone = seen.complete
          }
        : undefined

      const completion = await complete(
        providerId,
        { model },
        {
          system,
          user: buildUserPrompt({ prompt, analysis: before, options, examples, retry, feedback }),
          temperature: 0.3,
          // The local model shares an 8k context between input and output.
          maxTokens: providerId === 'local' ? 2048 : 4000,
          jsonMode: true,
          jsonSchema: OUTPUT_SCHEMA,
          signal: controller.signal,
          onStage: (stage, detail) => send({ type: 'stage', stage, attempt: which, ...detail }),
          onTextChunk,
        }
      )
      usage.inputTokens += completion.usage?.inputTokens || 0
      usage.outputTokens += completion.usage?.outputTokens || 0
      modelName = completion.model
      const result = normalizeResult(extractJson(completion.text), { originalPrompt: prompt })
      return { result, check: validateRewrite(prompt, result.fixedPrompt, { ...options, examples, feedback }) }
    }

    let best = await attempt()
    let retryError
    if (!best.check.ok) {
      // One corrective retry, telling the model exactly what was wrong. It
      // only exists to improve a result we already have, so if it fails the
      // first attempt is still the answer — unless the client has gone away.
      let second
      try {
        second = await attempt({ previous: best.result.fixedPrompt, reasons: best.check.reasons })
      } catch (err) {
        if (controller.signal.aborted) throw err
        retryError = err
      }
      best = pickBest(best, second)
    }

    let fixedPrompt = best.result.fixedPrompt
    let warning
    let warningKind
    if (!best.check.ok) {
      if (best.check.leaked) {
        // Last resort: strip our own boilerplate rather than show it to the
        // user. If nothing survives, the whole reply was our message — show
        // the original rather than an empty rewrite.
        warningKind = 'leak'
        // A copied example has nothing of the user's in it to keep.
        const scrubbed = best.check.copiedExample ? '' : scrubLeakedInstructions(fixedPrompt, prompt, feedback)
        fixedPrompt = scrubbed || prompt
        warning = best.check.copiedExample
          ? 'The model returned one of your saved examples instead of a rewrite twice, so your original is shown unchanged. Try again, or turn off "Use my library as examples" for this prompt.'
          : scrubbed
            ? 'The model copied its instructions into the rewrite twice; the boilerplate was stripped, so check the result carefully.'
            : 'The model returned its instructions instead of a rewrite twice; nothing usable was left, so your original is shown unchanged.'
      } else if (best.check.retention < best.check.minRetention) {
        warningKind = 'retention'
        const kept = Math.round(best.check.retention * 100)
        // Never advise the strength the user is already on.
        const advice = options.strength === 'balanced' ? 'try Light touch' : 'try Balanced'
        warning = `The model rewrote more than "${strengthLabel}" allows — only ${kept}% of your words survived. Check the Diff tab; ${advice}, or add an instruction about what to keep.`
      } else if (best.check.words > best.check.maxWords) {
        warningKind = 'growth'
        const added = best.check.words - best.check.originalWords
        warning = `The model added more than "${strengthLabel}" allows — ${added} words of scaffolding on top of yours. Check the Diff tab, or add an instruction about what not to add.`
      } else {
        // All that is left to be wrong is the marks: nothing was scrubbed, so
        // the check's lists are the final ones.
        warningKind = 'feedback'
        const count = (n, one, many) => `${n} ${n === 1 ? one : many}`
        const missed = [
          best.check.missingKeep.length && count(best.check.missingKeep.length, 'kept passage is missing', 'kept passages are missing'),
          best.check.unchangedChange.length &&
            count(best.check.unchangedChange.length, 'passage to change is still there', 'passages to change are still there'),
        ].filter(Boolean)
        warning = `The model did not follow all of your marks — ${missed.join(' and ')}. Check the result, then mark it again, or add an instruction that says what you want instead.`
      }
    }
    if (retryError && warning) warning += ` (A corrective retry also failed: ${retryError.message})`

    // The guard's own lists, so the two cannot tell different stories. They
    // are about the text the user is shown — a leaked attempt was judged on its
    // scrub — except that an attempt with no rewrite in it followed no mark at
    // all, even where the original shown in its place happens to satisfy one.
    const feedbackMeta = feedback
      ? {
          keep: feedback.keep.length,
          change: feedback.change.length,
          missingKeep: best.check.missingKeep,
          unchangedChange: best.check.unchangedChange,
        }
      : undefined

    // rewrite: true — placeholders the model deliberately added are a reminder, not a defect.
    const after = analyzePrompt(fixedPrompt, { ...lintOptions, rewrite: true })

    const body = {
      original: prompt,
      ...best.result,
      fixedPrompt,
      before,
      after,
      meta: {
        provider: providerId,
        model: modelName,
        usage,
        elapsedMs: Date.now() - started,
        options,
        retention: best.check.retention,
        minRetention: best.check.minRetention,
        attempts,
        warning,
        warningKind,
        examplesUsed: examples.length,
        // Only on a "fix again"; undefined drops out of the JSON.
        feedback: feedbackMeta,
      },
    }

    if (!streaming) {
      res.json(body)
      return
    }
    // The same object the non-streaming route returns, so a client that only
    // wants the answer can ignore every earlier event and read this one.
    send({ type: 'result', result: body })
    res.end()
  })
)

// --- library -----------------------------------------------------------------

app.get(
  '/api/library',
  wrap(async (req, res) => {
    const entries = await store.list({ query: String(req.query.q || '') })
    res.json({ entries })
  })
)

app.post(
  '/api/library',
  wrap(async (req, res) => {
    const entry = await store.save(req.body || {})
    res.status(201).json({ entry })
  })
)

app.get(
  '/api/library/export',
  wrap(async (_req, res) => {
    const exportedAt = new Date().toISOString()
    // The same envelope as library.json on disk, so either file imports.
    res.setHeader('Content-Disposition', `attachment; filename="promptfixer-library-${exportedAt.slice(0, 10)}.json"`)
    // `version` is the file format, unchanged since the first release.
    // `appVersion` is the build that wrote the file — a different question, and
    // the one that explains why an old entry scores differently today.
    res.json({ version: 1, appVersion: VERSION, exportedAt, entries: await store.list() })
  })
)

app.post(
  '/api/library/import',
  wrap(async (req, res) => {
    const entries = req.body?.entries
    if (!Array.isArray(entries)) {
      const err = new Error('Expected a JSON body of the form { "entries": [...] } — a PromptFixer library export.')
      err.status = 400
      throw err
    }
    res.json(await store.importEntries(entries))
  })
)

app.delete(
  '/api/library/:id',
  wrap(async (req, res) => {
    if (req.params.id === 'all') {
      res.json(await store.clear())
      return
    }
    res.json(await store.remove(req.params.id))
  })
)

// --- local model -------------------------------------------------------------

app.get('/api/local/status', (_req, res) => {
  res.json(local.getStatus())
})

app.post(
  '/api/local/download',
  wrap(async (req, res) => {
    res.json(await local.startDownload(req.body?.tier))
  })
)

app.post('/api/local/cancel', (_req, res) => {
  res.json(local.cancelDownload())
})

app.post(
  '/api/local/select',
  wrap(async (req, res) => {
    res.json(local.selectTier(String(req.body?.tier || '')))
  })
)

app.post(
  '/api/local/load',
  wrap(async (_req, res) => {
    await local.ensureLoaded()
    res.json(local.getStatus())
  })
)

app.post(
  '/api/local/unload',
  wrap(async (_req, res) => {
    await local.unload()
    res.json(local.getStatus())
  })
)

// Reclaiming the disk without hunting through a hidden folder: deletes the
// finished model and any part-file a cancelled download left behind.
app.delete(
  '/api/local/model/:tier',
  wrap(async (req, res) => {
    res.json(await local.removeModel(String(req.params.tier || '')))
  })
)

// An unknown API path is an API error like any other — JSON, through the
// handler below — not Express's HTML "Cannot GET" page.
app.use('/api', (req, _res, next) => {
  const err = new Error(`No such route: ${req.method} /api${req.path}`)
  err.status = 404
  next(err)
})

// --- static build (npm run build && npm start) -------------------------------

const dist = path.join(__dirname, '..', 'dist')
app.use(express.static(dist))
app.get(/^(?!\/api\/).*/, (_req, res, next) => {
  res.sendFile(path.join(dist, 'index.html'), (err) => (err ? next() : undefined))
})

// --- errors ------------------------------------------------------------------

app.use((err, _req, res, _next) => {
  const known = err instanceof ProviderError || err instanceof local.LocalModelError
  const status = err instanceof ProviderError ? err.status || 502 : err.status || 500
  if (status >= 500 && !known) console.error(err)

  // A streaming reply has already committed its 200, so the failure has to
  // travel as the last event. Without this the client would see a body that
  // just stops, with nothing saying why.
  if (res.headersSent) {
    // Guarded as a pair: ending a response that has already ended can destroy
    // the connection, and a connection destroyed here surfaces as ECONNRESET
    // on whatever request the client had pooled on it.
    if (!res.writableEnded) {
      writeEvent(res, {
        type: 'error',
        error: redact(err.message || 'Something went wrong.'),
        status,
        code: err.code ?? null,
        retryable: !!err.retryable,
      })
      res.end()
    }
    return
  }

  res.status(status).json({
    // Belt and braces: providers.js redacts at the source, but no message
    // from any path may carry a key to the browser.
    error: redact(err.message || 'Something went wrong.'),
    // Always present so the client can rely on the shape, null when unknown.
    provider: err.provider ?? null,
    code: err.code ?? null,
    retryable: !!err.retryable,
  })
})

// --- startup -----------------------------------------------------------------

/**
 * Start listening. Electron calls this in-process with `port: 0` to get a free
 * port; `node server/index.js` calls it with the configured PORT.
 */
export function start({ port = PORT, preload = process.env.PROMPTFIXER_PRELOAD === '1' } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port
      const configured = providerStatus().filter((p) => p.configured)
      console.log(`\n  PromptFixer API  →  http://localhost:${actualPort}`)
      console.log(
        `  Providers ready  →  ${configured.length ? configured.map((p) => p.label).join(', ') : 'none (download the local model or add a key to .env)'}\n`
      )
      if (preload) local.preload()
      resolve({ port: actualPort, server })
    })
    server.on('error', reject)
  })
}

const runDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (runDirectly) {
  start().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
