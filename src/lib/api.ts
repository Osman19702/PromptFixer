import type {
  Analysis,
  AppConfig,
  ExamplePrompt,
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

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    })
  } catch {
    throw new ApiError('Cannot reach the PromptFixer server. Is `npm run dev` still running?', 0, true)
  }

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

  fix: (payload: FixPayload, signal?: AbortSignal) =>
    call<FixResult>('/fix', {
      method: 'POST',
      body: JSON.stringify(payload),
      signal,
    }),

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
