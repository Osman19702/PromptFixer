/**
 * Pluggable model providers.
 *
 * Every adapter exposes the same two operations:
 *   listModels(cfg)                  -> string[]   (live from the provider, falls back to `models`)
 *   complete(cfg, { system, user }) -> { text, usage, model, finishReason }
 *
 * `finishReason` is normalised to 'length' when the reply hit the output cap,
 * so the caller can report a cut-off reply instead of blaming the JSON.
 *
 * Deliberately no vendor SDKs: each provider is a couple of fetch calls, which
 * keeps the dependency surface at zero and makes adding a new one a ~20 line job.
 */

import { currentTier } from './local-llm.js'
import { MODELS, isDownloaded } from './models.js'

// Overridable so a test can exercise the deadline without waiting two minutes.
const defaultTimeoutMs = () => Number(process.env.PROVIDER_TIMEOUT_MS) || 120_000

class ProviderError extends Error {
  constructor(message, { status, provider, retryable = false } = {}) {
    super(message)
    this.name = 'ProviderError'
    this.status = status
    this.provider = provider
    this.retryable = retryable
  }
}

const KEY_ENVS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'COMPATIBLE_API_KEY']

/**
 * Blank out every configured key in a piece of text. Some endpoints echo the
 * key back in their error body ("invalid key sk-…"), and that body becomes
 * the message the browser shows — which is the one place a key must never go.
 */
export function redact(text) {
  let out = String(text ?? '')
  for (const name of KEY_ENVS) {
    const key = process.env[name]
    if (key && key.length >= 8) out = out.split(key).join('[redacted]')
  }
  return out
}

async function request(url, init = {}, { provider, timeoutMs = defaultTimeoutMs(), signal } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  // The caller's signal (a client that went away) aborts alongside the deadline.
  const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
  let res
  let raw
  try {
    res = await fetch(url, { ...init, signal: combined })
    // Inside the deadline on purpose: a server that sends headers and then
    // stalls the body used to hang the request forever.
    raw = await res.text()
  } catch (err) {
    if (signal?.aborted) {
      throw new ProviderError(`${provider}: request cancelled.`, { provider, status: 499 })
    }
    if (err.name === 'AbortError' || controller.signal.aborted) {
      throw new ProviderError(`${provider}: request timed out after ${timeoutMs / 1000}s`, {
        provider,
        retryable: true,
      })
    }
    throw new ProviderError(
      `${provider}: could not reach the API (${redact(err.cause?.code || err.message)}).`,
      { provider, retryable: true }
    )
  } finally {
    clearTimeout(timer)
  }

  let body
  try {
    body = raw ? JSON.parse(raw) : {}
  } catch {
    body = { raw }
  }

  if (!res.ok) {
    const detail =
      body?.error?.message ||
      body?.error?.[0]?.message ||
      body?.message ||
      body?.detail ||
      (typeof body?.raw === 'string' ? body.raw.slice(0, 400) : '') ||
      res.statusText
    throw new ProviderError(`${provider}: ${res.status} ${redact(detail)}`, {
      status: res.status,
      provider,
      retryable: res.status === 429 || res.status >= 500,
    })
  }
  return body
}

/** Strip params a given model rejects, then retry once. Newer OpenAI models do this a lot. */
function paramsToDropFrom(message = '') {
  const drops = []
  const m = message.toLowerCase()
  if (m.includes('temperature')) drops.push('temperature')
  if (m.includes('max_tokens')) drops.push('max_tokens')
  if (m.includes('max_completion_tokens')) drops.push('max_completion_tokens')
  if (m.includes('response_format')) drops.push('response_format')
  if (m.includes('top_p')) drops.push('top_p')
  return drops
}

// --- OpenAI-compatible (OpenAI, OpenRouter, LM Studio, vLLM, Groq, Together) --

function openAiCompatible({ id, label, baseUrl, keyEnv, docs, extraHeaders = {}, models = [], keyOptional = false }) {
  return {
    id,
    label,
    keyEnv,
    keyOptional,
    docs,
    models,
    baseUrl,

    resolveBaseUrl(cfg) {
      return (cfg.baseUrl || baseUrl || '').replace(/\/+$/, '')
    },

    headers(cfg) {
      const h = { 'content-type': 'application/json', ...extraHeaders }
      if (cfg.apiKey) h.authorization = `Bearer ${cfg.apiKey}`
      return h
    },

    async listModels(cfg) {
      const body = await request(
        `${this.resolveBaseUrl(cfg)}/models`,
        { headers: this.headers(cfg) },
        { provider: label, timeoutMs: 20_000 }
      )
      const ids = (body.data || body.models || [])
        .map((m) => m.id || m.name)
        .filter(Boolean)
      return ids.sort()
    },

    async complete(cfg, { system, user, temperature, maxTokens, jsonMode, signal }) {
      const url = `${this.resolveBaseUrl(cfg)}/chat/completions`
      let payload = {
        model: cfg.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature,
        max_completion_tokens: maxTokens,
      }
      if (jsonMode) payload.response_format = { type: 'json_object' }

      let lastError
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const body = await request(
            url,
            { method: 'POST', headers: this.headers(cfg), body: JSON.stringify(payload) },
            { provider: label, signal }
          )
          const choice = body.choices?.[0]
          return {
            text: choice?.message?.content ?? '',
            model: body.model || cfg.model,
            finishReason: choice?.finish_reason,
            usage: {
              inputTokens: body.usage?.prompt_tokens,
              outputTokens: body.usage?.completion_tokens,
            },
          }
        } catch (err) {
          lastError = err
          const drops = err.status === 400 ? paramsToDropFrom(err.message) : []
          // Some endpoints only accept the legacy max_tokens name.
          if (err.status === 400 && /max_completion_tokens/.test(err.message) && payload.max_completion_tokens) {
            const { max_completion_tokens, ...rest } = payload
            payload = { ...rest, max_tokens: max_completion_tokens }
            continue
          }
          if (drops.length) {
            payload = { ...payload }
            for (const key of drops) delete payload[key]
            continue
          }
          throw err
        }
      }
      // Ran out of retries: surface what the provider actually said, not a guess.
      throw lastError ??
        new ProviderError(`${label}: model rejected the request parameters.`, { provider: label })
    },
  }
}

// --- Anthropic ---------------------------------------------------------------

const anthropic = {
  id: 'anthropic',
  label: 'Anthropic',
  keyEnv: 'ANTHROPIC_API_KEY',
  docs: 'https://console.anthropic.com/settings/keys',
  baseUrl: 'https://api.anthropic.com/v1',
  models: ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001'],

  headers(cfg) {
    return {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    }
  },

  async listModels(cfg) {
    const body = await request(
      `${this.baseUrl}/models?limit=100`,
      { headers: this.headers(cfg) },
      { provider: this.label, timeoutMs: 20_000 }
    )
    return (body.data || []).map((m) => m.id).filter(Boolean)
  },

  async complete(cfg, { system, user, temperature, maxTokens, signal }) {
    const body = await request(
      `${this.baseUrl}/messages`,
      {
        method: 'POST',
        headers: this.headers(cfg),
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: maxTokens,
          temperature,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      },
      { provider: this.label, signal }
    )
    const text = (body.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
    return {
      text,
      model: body.model || cfg.model,
      finishReason: body.stop_reason === 'max_tokens' ? 'length' : body.stop_reason,
      usage: { inputTokens: body.usage?.input_tokens, outputTokens: body.usage?.output_tokens },
    }
  },
}

// --- Google Gemini -----------------------------------------------------------

const google = {
  id: 'google',
  label: 'Google Gemini',
  keyEnv: 'GOOGLE_API_KEY',
  docs: 'https://aistudio.google.com/apikey',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  models: ['gemini-2.5-pro', 'gemini-2.5-flash'],

  async listModels(cfg) {
    const body = await request(
      `${this.baseUrl}/models?key=${encodeURIComponent(cfg.apiKey)}&pageSize=200`,
      {},
      { provider: this.label, timeoutMs: 20_000 }
    )
    return (body.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter(Boolean)
  },

  async complete(cfg, { system, user, temperature, maxTokens, jsonMode, signal }) {
    const model = String(cfg.model).replace(/^models\//, '')
    const body = await request(
      `${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: {
            temperature,
            maxOutputTokens: maxTokens,
            ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
          },
        }),
      },
      { provider: this.label, signal }
    )
    const candidate = body.candidates?.[0]
    const text = (candidate?.content?.parts || []).map((p) => p.text || '').join('')
    return {
      text,
      model,
      finishReason: candidate?.finishReason === 'MAX_TOKENS' ? 'length' : candidate?.finishReason,
      usage: {
        inputTokens: body.usageMetadata?.promptTokenCount,
        outputTokens: body.usageMetadata?.candidatesTokenCount,
      },
    }
  },
}

// --- Ollama (local) ----------------------------------------------------------

const ollama = {
  id: 'ollama',
  label: 'Ollama (local)',
  keyEnv: null,
  keyOptional: true,
  docs: 'https://ollama.com/download',
  baseUrl: 'http://localhost:11434',
  models: [],

  resolveBaseUrl(cfg) {
    return (cfg.baseUrl || this.baseUrl).replace(/\/+$/, '')
  },

  async listModels(cfg) {
    const body = await request(
      `${this.resolveBaseUrl(cfg)}/api/tags`,
      {},
      { provider: this.label, timeoutMs: 10_000 }
    )
    return (body.models || []).map((m) => m.name).filter(Boolean)
  },

  async complete(cfg, { system, user, temperature, maxTokens, jsonMode, signal }) {
    const body = await request(
      `${this.resolveBaseUrl(cfg)}/api/chat`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          stream: false,
          ...(jsonMode ? { format: 'json' } : {}),
          options: { temperature, num_predict: maxTokens },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      },
      { provider: this.label, signal }
    )
    return {
      text: body.message?.content ?? '',
      model: body.model || cfg.model,
      finishReason: body.done_reason,
      usage: { inputTokens: body.prompt_eval_count, outputTokens: body.eval_count },
    }
  },
}

// --- Local (built-in, node-llama-cpp) ----------------------------------------
//
// `cfg.model` is a tier id from models.js, not a model name — the UI renders
// the tier catalog for this provider instead of the plain model list.

const local = {
  id: 'local',
  label: 'Local (built-in)',
  keyEnv: null,
  keyOptional: true,
  docs: '',
  baseUrl: '',
  // Live selected tier first: resolveConfig() falls back to models[0], so a
  // request without a model must land on the tier the user picked, not the
  // env/RAM default frozen at import time.
  get models() {
    const tier = currentTier()
    return [tier, ...Object.keys(MODELS).filter((k) => k !== tier)]
  },

  async listModels() {
    return this.models
  },

  async complete(cfg, args) {
    const llm = await import('./local-llm.js')
    if (cfg.model && MODELS[cfg.model]) llm.selectTier(cfg.model)
    return llm.complete(args)
  },
}

// --- registry ----------------------------------------------------------------

export const PROVIDERS = {
  local,
  anthropic,
  openai: openAiCompatible({
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY',
    docs: 'https://platform.openai.com/api-keys',
    models: ['gpt-4.1', 'gpt-4o', 'gpt-4o-mini'],
  }),
  openrouter: openAiCompatible({
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    docs: 'https://openrouter.ai/keys',
    extraHeaders: { 'HTTP-Referer': 'http://localhost:5173', 'X-Title': 'PromptFixer' },
    models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-4.1', 'google/gemini-2.5-pro'],
  }),
  google,
  ollama,
  compatible: openAiCompatible({
    id: 'compatible',
    label: process.env.COMPATIBLE_LABEL || 'OpenAI-compatible',
    baseUrl: process.env.COMPATIBLE_BASE_URL || '',
    keyEnv: 'COMPATIBLE_API_KEY',
    keyOptional: true,
    docs: '',
    models: [],
  }),
}

/**
 * A per-request base URL is only honoured for the key-less local endpoints.
 * The adapters put the server's API key in the Authorization header for
 * whatever host they are pointed at, and GET /api/models is a CORS "simple
 * request" any web page can fire at localhost — so a client-chosen host plus
 * a stored key would be a one-line key exfiltration. Env is the only way to
 * set a base URL for a keyed provider.
 */
function requestBaseUrl(providerId, apiKey, raw) {
  const allowed = (providerId === 'ollama' || providerId === 'compatible') && !apiKey
  if (!allowed || typeof raw !== 'string' || !raw) return ''
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new ProviderError('baseUrl must be an http(s) URL.', { status: 400 })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProviderError('baseUrl must be an http(s) URL.', { status: 400 })
  }
  return raw
}

/** Build the runtime config for a provider from env + per-request overrides. */
export function resolveConfig(providerId, overrides = {}) {
  const provider = PROVIDERS[providerId]
  if (!provider) {
    throw new ProviderError(`Unknown provider "${providerId}".`, { status: 400 })
  }
  const apiKey = overrides.apiKey || (provider.keyEnv ? process.env[provider.keyEnv] : '') || ''
  const baseUrl =
    requestBaseUrl(providerId, apiKey, overrides.baseUrl) ||
    (providerId === 'ollama' ? process.env.OLLAMA_BASE_URL : '') ||
    (providerId === 'compatible' ? process.env.COMPATIBLE_BASE_URL : '') ||
    provider.baseUrl ||
    ''

  if (!apiKey && !provider.keyOptional) {
    throw new ProviderError(
      `${provider.label} needs an API key. Set ${provider.keyEnv} in your .env file and restart the server.`,
      { status: 400, provider: provider.label }
    )
  }
  if (!baseUrl && providerId !== 'local') {
    throw new ProviderError(
      `${provider.label} needs a base URL. Set COMPATIBLE_BASE_URL in your .env file.`,
      { status: 400, provider: provider.label }
    )
  }

  return {
    provider,
    apiKey,
    baseUrl,
    model: overrides.model || provider.models[0] || '',
  }
}

/** What the UI needs to render the provider picker, without leaking key values. */
export function providerStatus() {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    keyEnv: p.keyEnv,
    keyOptional: !!p.keyOptional,
    docs: p.docs,
    fallbackModels: p.models,
    configured:
      p.id === 'local'
        ? isDownloaded(currentTier())
        : p.keyOptional
          ? !!(p.id === 'ollama' ? process.env.OLLAMA_BASE_URL || p.baseUrl : process.env.COMPATIBLE_BASE_URL)
          : !!process.env[p.keyEnv],
  }))
}

export async function listModels(providerId, overrides = {}) {
  const cfg = resolveConfig(providerId, overrides)
  try {
    const live = await cfg.provider.listModels(cfg)
    if (live.length) return { models: live, source: 'live' }
  } catch (err) {
    // A rejected key is definitive; hiding it behind the fallback list would
    // let the user pick a model and only find out on the first fix.
    if (err.status === 401 || err.status === 403) throw err
    if (!cfg.provider.models.length) throw err
  }
  return { models: cfg.provider.models, source: 'fallback' }
}

export async function complete(providerId, overrides, args) {
  const cfg = resolveConfig(providerId, overrides)
  if (!cfg.model) {
    throw new ProviderError(`${cfg.provider.label}: no model selected.`, { status: 400 })
  }
  const completion = await cfg.provider.complete(cfg, args)
  if (completion.finishReason === 'length') {
    const cap = args?.maxTokens ? `the ${args.maxTokens}-token output limit` : 'its output limit'
    throw new ProviderError(
      `${cfg.provider.label}: the reply was cut off at ${cap}; shorten the prompt or try again.`,
      { status: 502, provider: cfg.provider.label, retryable: true }
    )
  }
  return completion
}

export { ProviderError }
