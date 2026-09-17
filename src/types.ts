export type Severity = 'high' | 'medium' | 'low'
export type CategoryKey = 'clarity' | 'specificity' | 'context' | 'format' | 'structure'

export interface Issue {
  id: string
  title: string
  category: CategoryKey
  severity: Severity
  detail: string
  suggestion: string
  evidence: string[]
}

export interface Analysis {
  empty: boolean
  score: number
  grade: string
  categories: Record<CategoryKey, number>
  issues: Issue[]
  strengths: string[]
  stats: {
    words: number
    sentences: number
    lines: number
    characters: number
    estimatedTokens: number
  }
}

export interface Change {
  type: string
  what: string
  why: string
}

export interface FixOptions {
  intent: string
  targetModel: string
  strength: string
  preserveTone: boolean
  includeExample: boolean
  addRole: boolean
  notes: string
  /** Let the server show the model earlier rewrites the user kept in the library. */
  fewShot: boolean
}

export type WarningKind = 'leak' | 'retention' | 'growth' | 'feedback'

/**
 * The user's marks on an earlier rewrite, sent with POST /api/fix to refine it.
 * `prompt` stays the original, so scores, diff and the guard still measure
 * against what the user wrote.
 */
export interface FixFeedback {
  /** The rewrite that was marked up (an earlier fixedPrompt). */
  previous: string
  /** Passages of `previous` that must come back word for word. */
  keep: string[]
  /** Passages of `previous` that must not survive as they are. */
  change: string[]
}

export interface FixResult {
  original: string
  fixedPrompt: string
  summary: string
  changes: Change[]
  assumptions: string[]
  questions: string[]
  techniques: string[]
  before: Analysis
  after: Analysis
  meta: {
    provider: string
    model: string
    usage?: { inputTokens?: number; outputTokens?: number }
    elapsedMs: number
    options: FixOptions
    /** Fraction (0..1) of the original's content words that survived the rewrite. */
    retention: number
    minRetention: number
    attempts: number
    /** Set when the rewrite stayed below the strength's retention floor even after a retry. */
    warning?: string
    /** Which check produced `warning`; older servers omit it and the UI infers it. */
    warningKind?: WarningKind
    /** How many library entries were shown to the model as examples (0 when fewShot is off). */
    examplesUsed: number
    /** Present only when the request carried marks that survived the server's sanitising. */
    feedback?: {
      /** How many passages of each kind were sent to the model. */
      keep: number
      change: number
      /** Kept passages that are not in fixedPrompt after all. */
      missingKeep: string[]
      /** Passages to change that are still in fixedPrompt verbatim. */
      unchangedChange: string[]
    }
  }
}

/** A curated starting prompt from GET /api/examples. */
export interface ExamplePrompt {
  id: string
  name: string
  useCase: string
  prompt: string
  intent: string
  strength: string
  /** What a demo should see: the lint score, top issues, and how the fixer should react. */
  expected: string
}

export interface ProviderInfo {
  id: string
  label: string
  keyEnv: string | null
  keyOptional: boolean
  docs: string
  fallbackModels: string[]
  configured: boolean
}

export interface Preset {
  id: string
  label: string
  hint?: string
}

export type LocalPhase = 'missing' | 'downloading' | 'downloaded' | 'loading' | 'ready' | 'error'

export interface LocalModelInfo {
  id: string
  label: string
  bytes: number
  blurb: string
}

export interface LocalStatus {
  tier: string
  model: LocalModelInfo
  path: string
  modelDir: string
  phase: LocalPhase
  downloaded: boolean
  loaded: boolean
  progress: { downloaded: number; total: number; percent: number }
  gpu: string | null
  device: string | null
  error: string | null
  /** True while a generation is running; absent on servers that predate it. */
  busy?: boolean
  lastRun: {
    inputTokens: number
    outputTokens: number
    elapsedMs: number
    tokensPerSecond: number | null
  } | null
  catalog: (LocalModelInfo & { minRamGb: number; recommended: boolean; downloaded: boolean })[]
}

export interface AppConfig {
  providers: ProviderInfo[]
  defaultProvider: string
  defaultModel: string
  desktop: boolean
  categories: Record<CategoryKey, { label: string; weight: number; blurb: string }>
  presets: {
    intents: Preset[]
    targetModels: Preset[]
    strengths: Preset[]
  }
  limits: { maxPromptChars: number }
}

export interface LibraryEntry {
  id: string
  title: string
  original: string
  fixed: string
  summary: string
  options: Partial<FixOptions>
  scoreBefore: number | null
  scoreAfter: number | null
  provider: string | null
  model: string | null
  tags: string[]
  favorite: boolean
  createdAt: string
  updatedAt: string
}

/** The GET /api/library/export body; POST /api/library/import takes its `entries`. */
export interface LibraryExport {
  version: number
  exportedAt: string
  entries: LibraryEntry[]
}

export interface ImportResult {
  imported: number
  skipped: number
  total: number
}
