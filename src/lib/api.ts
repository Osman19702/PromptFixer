import type {
  Analysis,
  AppConfig,
  ExamplePrompt,
  FixEvent,
  FixFeedback,
  FixOptions,
  FixResult,
  ImportResult,
  LibraryEntry,
  LibraryExport,
  LocalStatus,
} from '../types'

export interface FixPayload {
  /** Always the user's original prompt, also when refining an earlier rewrite. */
  prompt: string
  provider: string
  model: string
  options: FixOptions
  /** Marks on an earlier rewrite; without it this is an ordinary fix. */
  feedback?: FixFeedback
}

export class ApiError extends Error {
  status: number
  retryable: boolean
  constructor(message: string, status: number, retryable = false) {
    super(message)
    this.status = status
    this.retryable = retryable
  }
}

/** The one message for a server that is not answering at all. */
const unreachable = () =>
  new ApiError('Cannot reach the PromptFixer server. Is `npm run dev` still running?', 0, true)

async function send(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`/api${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    })
  } catch (err) {
    // An abort is the caller's own doing; dressing it up as an unreachable
    // server would raise the connection banner every time Cancel is pressed.
    if ((err as Error)?.name === 'AbortError') throw err
    throw unreachable()
  }
}

/** The whole body as JSON, or the error it describes. One error contract. */
async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text()
  let body: unknown = {}
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { error: text.slice(0, 300) }
  }
  if (!res.ok) {
    const payload = body as { error?: string; retryable?: boolean }
    throw new ApiError(payload.error || `Request failed (${res.status})`, res.status, !!payload.retryable)
  }
  return body as T
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  return readJson<T>(await send(path, init))
}

/**
 * Read a newline-delimited JSON response, handing each event to `onEvent` as it
 * lands, and resolve with the `result` event's payload.
 *
 * Failures arrive two ways and both have to end as an ApiError: before the
 * reply commits, as an ordinary JSON error body; after it commits, as a final
 * `error` event, because the status line has already gone out as 200.
 */
async function stream(
  path: string,
  payload: unknown,
  onEvent: (event: FixEvent) => void,
  signal?: AbortSignal
): Promise<FixResult> {
  const res = await send(path, {
    method: 'POST',
    headers: { accept: 'application/x-ndjson' },
    body: JSON.stringify(payload),
    signal,
  })

  // Not streaming: an error before the first chunk, a server that predates
  // this, or anything that buffered the reply into one object. Either way the
  // body is one JSON document and the shared reader handles it.
  if (!res.body || !res.headers.get('content-type')?.includes('x-ndjson')) {
    return readJson<FixResult>(res)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: FixResult | null = null
  let failure: ApiError | null = null

  const take = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let event: FixEvent
    try {
      event = JSON.parse(trimmed) as FixEvent
    } catch {
      // A half-written line can only be the last one, and the loop below only
      // ever hands over complete lines, so this is a server that went wrong.
      return
    }
    if (event.type === 'result') result = event.result
    else if (event.type === 'error') failure = new ApiError(event.error, event.status, event.retryable)
    onEvent(event)
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // Everything up to the last newline is whole; the remainder waits.
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) take(line)
    }
    take(buffer + decoder.decode())
  } finally {
    reader.cancel().catch(() => {})
  }

  if (failure) throw failure
  if (!result) throw new ApiError('The server stopped before the fix was finished.', 502, true)
  return result
}

export const api = {
  config: () => call<AppConfig>('/config'),

  models: (provider: string) =>
    call<{ models: string[]; source: 'live' | 'fallback' }>(
      `/models?provider=${encodeURIComponent(provider)}`
    ),

  analyze: (prompt: string, options: Partial<FixOptions>, signal?: AbortSignal) =>
    call<{ analysis: Analysis }>('/analyze', {
      method: 'POST',
      body: JSON.stringify({ prompt, options }),
      signal,
    }),

  /** A fix, with no interest in how it progresses. */
  fix: (payload: FixPayload, signal?: AbortSignal) => stream('/fix', payload, () => {}, signal),

  /**
   * The same request, reported as it happens. `onEvent` sees every stage, every
   * fresh attempt and the rewrite as it is written; the promise resolves with
   * the finished result either way.
   *
   * One route, one client: a server that does not stream replies with ordinary
   * JSON, which the reader handles, so there is no second code path to keep in
   * step — and the tests that guard the fix payload exercise what ships.
   */
  fixStream: (payload: FixPayload, onEvent: (event: FixEvent) => void, signal?: AbortSignal) =>
    stream('/fix', payload, onEvent, signal),

  examples: {
    list: () => call<{ examples: ExamplePrompt[] }>('/examples'),
  },

  local: {
    status: () => call<LocalStatus>('/local/status'),
    download: (tier?: string) =>
      call<LocalStatus>('/local/download', { method: 'POST', body: JSON.stringify({ tier }) }),
    cancel: () => call<LocalStatus>('/local/cancel', { method: 'POST' }),
    select: (tier: string) =>
      call<LocalStatus>('/local/select', { method: 'POST', body: JSON.stringify({ tier }) }),
    load: () => call<LocalStatus>('/local/load', { method: 'POST' }),
    /** Give the memory back; the next fix loads the model again. */
    unload: () => call<LocalStatus>('/local/unload', { method: 'POST' }),
    /** Delete a tier's files, finished or part-downloaded, and reclaim the disk. */
    remove: (tier: string) =>
      call<{ removed: string[]; freed: number; status: LocalStatus }>(
        `/local/model/${encodeURIComponent(tier)}`,
        { method: 'DELETE' }
      ),
  },

  library: {
    list: (q = '') => call<{ entries: LibraryEntry[] }>(`/library?q=${encodeURIComponent(q)}`),
    save: (entry: Partial<LibraryEntry>) =>
      call<{ entry: LibraryEntry }>('/library', { method: 'POST', body: JSON.stringify(entry) }),
    remove: (id: string) => call<{ removed: boolean }>(`/library/${id}`, { method: 'DELETE' }),
    export: () => call<LibraryExport>('/library/export'),
    import: (entries: LibraryEntry[]) =>
      call<ImportResult>('/library/import', { method: 'POST', body: JSON.stringify({ entries }) }),
  },
}
