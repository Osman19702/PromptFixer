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
  extractJson,
  normalizeResult,
  pickBest,
  presets,
  scrubLeakedInstructions,
  validateRewrite,
} from './metaprompt.js'
import { ProviderError, complete, listModels, providerStatus } from './providers.js'
import * as store from './store.js'

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

// --- meta --------------------------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, version: '0.1.0' })
})

app.get('/api/config', (_req, res) => {
  res.json({
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

    const attempt = async (retry) => {
      if (controller.signal.aborted) {
        const err = new Error('The request was cancelled.')
        err.status = 499
        throw err
      }
      attempts++
      const completion = await complete(
        providerId,
        { model },
        {
          system,
          user: buildUserPrompt({ prompt, analysis: before, options, examples, retry }),
          temperature: 0.3,
          // The local model shares an 8k context between input and output.
          maxTokens: providerId === 'local' ? 2048 : 4000,
          jsonMode: true,
          jsonSchema: OUTPUT_SCHEMA,
          signal: controller.signal,
        }
      )
      usage.inputTokens += completion.usage?.inputTokens || 0
      usage.outputTokens += completion.usage?.outputTokens || 0
      modelName = completion.model
      const result = normalizeResult(extractJson(completion.text), { originalPrompt: prompt })
      return { result, check: validateRewrite(prompt, result.fixedPrompt, options) }
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
        const scrubbed = scrubLeakedInstructions(fixedPrompt, prompt)
        fixedPrompt = scrubbed || prompt
        warning = scrubbed
          ? 'The model copied its instructions into the rewrite twice; the boilerplate was stripped, so check the result carefully.'
          : 'The model returned its instructions instead of a rewrite twice; nothing usable was left, so your original is shown unchanged.'
      } else if (best.check.retention < best.check.minRetention) {
        warningKind = 'retention'
        const kept = Math.round(best.check.retention * 100)
        // Never advise the strength the user is already on.
        const advice = options.strength === 'balanced' ? 'try Light touch' : 'try Balanced'
        warning = `The model rewrote more than "${strengthLabel}" allows — only ${kept}% of your words survived. Check the Diff tab; ${advice}, or add an instruction about what to keep.`
      } else {
        warningKind = 'growth'
        const added = best.check.words - best.check.originalWords
        warning = `The model added more than "${strengthLabel}" allows — ${added} words of scaffolding on top of yours. Check the Diff tab, or add an instruction about what not to add.`
      }
    }
    if (retryError && warning) warning += ` (A corrective retry also failed: ${retryError.message})`

    // rewrite: true — placeholders the model deliberately added are a reminder, not a defect.
    const after = analyzePrompt(fixedPrompt, { ...lintOptions, rewrite: true })

    res.json({
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
      },
    })
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
    res.json({ version: 1, exportedAt, entries: await store.list() })
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
  res.status(status).json({
    error: err.message || 'Something went wrong.',
    provider: err.provider,
    code: err.code,
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
