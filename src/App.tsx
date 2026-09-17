import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DiffView } from './components/DiffView'
import { IssueList } from './components/IssueList'
import { Library } from './components/Library'
import { MarkableOutput } from './components/MarkableOutput'
import { Delta, ScorePanel } from './components/ScorePanel'
import { api, ApiError } from './lib/api'
import type { FixPayload } from './lib/api'
import {
  applyExample,
  canFix as fixAllowed,
  canRefine as refineAllowed,
  EMPTY_HISTORY,
  feedbackPayload,
  historyCurrent,
  historyDeselect,
  historyNav,
  historyPush,
  historyStep,
  learnedNote,
  localIdle,
  localTierAction,
  marksAfterSelect,
  readExamples,
  refinedNote,
  resultView,
  shownMarks,
  undoAvailable,
  warningHeadline,
} from './lib/ui'
import type { MarkedResult, UndoApply } from './lib/ui'
import type { Analysis, AppConfig, ExamplePrompt, FixOptions, LibraryEntry, LocalStatus } from './types'

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1)

const PREFS_KEY = 'promptfixer.prefs.v1'
const DRAFT_KEY = 'promptfixer.draft.v1'

const SAMPLE = `write a blog post about our new feature, make it good and professional. keep it brief but comprehensive, and cite some stats about the latest AI trends!!`

type Tab = 'fixed' | 'diff' | 'issues' | 'notes'

interface Prefs {
  provider: string
  model: string
  options: FixOptions
}

const DEFAULT_OPTIONS: FixOptions = {
  intent: 'general',
  targetModel: 'generic',
  strength: 'balanced',
  preserveTone: false,
  includeExample: false,
  addRole: false,
  notes: '',
  fewShot: true,
}

function loadPrefs(): Partial<Prefs> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')
  } catch {
    return {}
  }
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)

  const [prompt, setPrompt] = useState(() => localStorage.getItem(DRAFT_KEY) ?? '')
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  // The last HISTORY_LIMIT fix results; `result` is whichever one is selected.
  const [history, setHistory] = useState(EMPTY_HISTORY)
  const result = historyCurrent(history)
  // True after the user stepped through the history on purpose, so that result
  // owns the Issues tab too even though the editor may hold something else.
  const [pinned, setPinned] = useState(false)
  const [undo, setUndo] = useState<UndoApply | null>(null)
  const [examples, setExamples] = useState<ExamplePrompt[]>([])

  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [localStatus, setLocalStatus] = useState<LocalStatus | null>(null)
  const [localTick, setLocalTick] = useState(0)
  const [options, setOptions] = useState<FixOptions>(DEFAULT_OPTIONS)

  const [tab, setTab] = useState<Tab>('issues')
  const [fixing, setFixing] = useState(false)
  // True while the fix in flight is "Fix again with my marks", so its button shows the spinner.
  const [refining, setRefining] = useState(false)
  // Set by Cancel on the local provider and cleared once /api/local/status says
  // the server is idle, so a new Fix cannot queue behind the abandoned run.
  const [cancelling, setCancelling] = useState(false)
  // After the prompt is edited the last result hides behind a control.
  const [showLastFix, setShowLastFix] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toasts, setToasts] = useState<{ id: number; message: string; kind: string }[]>([])
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [libraryKey, setLibraryKey] = useState(0)
  const [showNotes, setShowNotes] = useState(false)

  const fixAbort = useRef<AbortController | null>(null)
  const editorRef = useRef<HTMLTextAreaElement | null>(null)
  const errorRef = useRef<HTMLDivElement | null>(null)

  const toast = useCallback((message: string, kind = 'info') => {
    const id = Date.now() + Math.random()
    setToasts((prev) => [...prev, { id, message, kind }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 2600)
  }, [])

  // --- config -------------------------------------------------------------
  useEffect(() => {
    api
      .config()
      .then((cfg) => {
        setConfig(cfg)
        const prefs = loadPrefs()
        // Respect the saved choice, then DEFAULT_PROVIDER, and only fall back to
        // "whatever has credentials" if neither of those actually exists.
        const wanted = prefs.provider || cfg.defaultProvider
        const exists = cfg.providers.some((p) => p.id === wanted)
        setProvider(exists ? wanted : cfg.providers.find((p) => p.configured)?.id || cfg.defaultProvider)
        setModel(prefs.model || cfg.defaultModel || '')
        setOptions({ ...DEFAULT_OPTIONS, ...(prefs.options ?? {}) })
        if (prefs.options?.notes) setShowNotes(true)
      })
      .catch((err) => setConfigError(err.message))
  }, [])

  // The gallery is optional: a server without /api/examples just leaves it empty.
  useEffect(() => {
    api.examples
      .list()
      .then((res) => setExamples(readExamples(res)))
      .catch(() => setExamples([]))
  }, [])

  // --- persist ------------------------------------------------------------
  useEffect(() => {
    if (!provider) return
    localStorage.setItem(PREFS_KEY, JSON.stringify({ provider, model, options }))
  }, [provider, model, options])

  useEffect(() => {
    const t = setTimeout(() => localStorage.setItem(DRAFT_KEY, prompt), 400)
    return () => clearTimeout(t)
  }, [prompt])

  // --- models -------------------------------------------------------------
  useEffect(() => {
    if (!provider || !config) return
    const info = config.providers.find((p) => p.id === provider)
    if (!info?.configured) {
      setModels(info?.fallbackModels ?? [])
      return
    }
    let cancelled = false
    setModelsLoading(true)
    setModelsError(null)
    api
      .models(provider)
      .then((res) => {
        if (cancelled) return
        setModels(res.models)
        setModel((current) => (current && res.models.includes(current) ? current : res.models[0] ?? ''))
      })
      .catch((err) => {
        if (cancelled) return
        setModels(info.fallbackModels)
        setModel((current) => current || info.fallbackModels[0] || '')
        if (!info.fallbackModels.length) setModelsError((err as Error).message)
      })
      .finally(() => !cancelled && setModelsLoading(false))
    return () => {
      cancelled = true
    }
  }, [provider, config])

  // --- local model status -------------------------------------------------
  // Polls only while something is in flight (download, load, or a local fix),
  // so an idle app makes no requests.
  useEffect(() => {
    if (!config) return
    let cancelled = false
    let timer: number | undefined
    const tick = async () => {
      try {
        const s = await api.local.status()
        if (cancelled) return
        setLocalStatus(s)
        if (cancelling && localIdle(s)) {
          setCancelling(false)
          return
        }
        const busy = s.phase === 'downloading' || s.phase === 'loading' || (fixing && provider === 'local')
        // A cancelled generation is dropped within a moment; poll it tightly.
        if (cancelling) timer = window.setTimeout(tick, 400)
        else if (busy) timer = window.setTimeout(tick, 1200)
      } catch {
        /* server unreachable; the config-error screen covers it */
      }
    }
    tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [config, provider, localTick, fixing, cancelling])

  // For the local provider the "model" is a tier id. Every desktop launch
  // restarts the server with its own default tier, so a remembered choice has
  // to be pushed to the server or status/canFix describe the wrong model.
  useEffect(() => {
    if (provider !== 'local' || !localStatus) return
    const action = localTierAction(model, localStatus)
    if (action.kind === 'adopt') setModel(action.tier)
    if (action.kind !== 'push') return
    let stale = false
    api.local
      .select(action.tier)
      .then((s) => !stale && setLocalStatus(s))
      .catch((err) => {
        if (stale) return
        setModel(localStatus.tier)
        toast((err as Error).message, 'error')
      })
    return () => {
      stale = true
    }
  }, [provider, localStatus, model, toast])

  // --- live linting -------------------------------------------------------
  useEffect(() => {
    if (!prompt.trim()) {
      setAnalysis(null)
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      api
        .analyze(prompt, { intent: options.intent }, controller.signal)
        .then((res) => setAnalysis(res.analysis))
        .catch(() => {})
    }, 350)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [prompt, options.intent])

  const providerInfo = useMemo(
    () => config?.providers.find((p) => p.id === provider),
    [config, provider]
  )
  const anyConfigured = useMemo(
    () => !!config?.providers.some((p) => p.configured),
    [config]
  )

  // Once the editor diverges from the fix's original, the live analysis leads
  // and the old result waits behind "Show last fix".
  const view = useMemo(
    () => resultView(result, analysis, prompt, showLastFix, pinned),
    [result, analysis, prompt, showLastFix, pinned]
  )
  useEffect(() => setShowLastFix(false), [result])
  // Typing releases a pinned history entry; the live analysis leads again.
  useEffect(() => setPinned(false), [prompt])
  const nav = historyNav(history)
  const stepHistory = (delta: number) => {
    setHistory((h) => historyStep(h, delta))
    setPinned(true)
  }

  // Marks belong to the one rewrite they were made on. Reading them through the
  // result they were made for means a history step or a new fix never paints
  // old highlights over different text, not even for a frame; the effect then
  // drops them for good, so stepping back does not bring them back either.
  // It follows the history's selection, not view.active: that goes null on the
  // first keystroke in the editor, and the same rewrite is one Backspace or one
  // "Show last fix" away, where the user expects their marks to be waiting.
  const [marked, setMarked] = useState<MarkedResult | null>(null)
  const marks = shownMarks(marked, view.active)
  useEffect(() => setMarked((m) => marksAfterSelect(m, result)), [result])

  // The button and the keyboard shortcut share this gate.
  const canFix = fixAllowed({ prompt, model, provider, fixing, cancelling, localStatus })
  // A refine is measured against the marked result's original, not the editor.
  const canRefine = refineAllowed(
    { prompt: view.active?.original ?? '', model, provider, fixing, cancelling, localStatus },
    marks
  )

  // --- actions ------------------------------------------------------------
  // Fix prompt and "Fix again with my marks" are one request with one in-flight
  // slot, so Cancel, the abort of a superseded run and the error banner behave
  // the same for both.
  const sendFix = useCallback(
    async (payload: FixPayload) => {
      const refine = !!payload.feedback
      fixAbort.current?.abort()
      const controller = new AbortController()
      fixAbort.current = controller

      setFixing(true)
      setRefining(refine)
      setError(null)
      try {
        const res = await api.fix(payload, controller.signal)
        setHistory((h) => historyPush(h, res))
        // A refine can start from a pinned or re-shown result while the editor
        // holds something else; without the pin its own result would hide at once.
        if (refine) setPinned(true)
        else setAnalysis(res.before)
        setTab('fixed')
        setLocalTick((t) => t + 1)
        const verb = refine ? 'Refined' : 'Fixed'
        toast(`${verb} in ${(res.meta.elapsedMs / 1000).toFixed(1)}s · ${res.before.score} → ${res.after.score}`)
      } catch (err) {
        if (controller.signal.aborted) return
        const message = err instanceof ApiError ? err.message : (err as Error).message
        setError(message)
        // A failed fix has nothing to show, so Issues leads. A failed refine
        // still has the marked rewrite: stay on it, marks intact, ready to retry.
        if (!refine) setTab('issues')
      } finally {
        if (!controller.signal.aborted) {
          setFixing(false)
          setRefining(false)
        }
      }
    },
    [toast]
  )

  const runFix = useCallback(() => {
    if (canFix) sendFix({ prompt, provider, model, options })
  }, [prompt, provider, model, options, canFix, sendFix])

  const runRefine = () => {
    const source = view.active
    const feedback = source && feedbackPayload(source.fixedPrompt, marks)
    if (!source || !feedback || !canRefine) return
    sendFix({ prompt: source.original, provider, model, options, feedback })
  }

  // The banner sits at the top of the pane; a refine is pressed from wherever
  // the user scrolled to, and an error they cannot see reads as a dead button.
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: 'nearest' })
  }, [error])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The drawer's search box should not fire a fix.
      if (libraryOpen) return
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        runFix()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [runFix, libraryOpen])

  const cancelFix = () => {
    fixAbort.current?.abort()
    setFixing(false)
    setRefining(false)
    // The server aborts the generation when the request closes; hold the Fix
    // button until status confirms it is idle rather than queue behind it.
    if (provider === 'local') setCancelling(true)
  }

  const copy = async (text: string, label = 'Copied') => {
    try {
      await navigator.clipboard.writeText(text)
      toast(label)
    } catch {
      toast('Clipboard blocked by the browser', 'error')
    }
  }

  const applyFix = () => {
    const active = view.active
    if (!active) return
    setUndo({ before: prompt, applied: active.fixedPrompt })
    setPrompt(active.fixedPrompt)
    setHistory(historyDeselect)
    setTab('issues')
    toast('Applied to the editor')
  }

  const undoApply = () => {
    if (!undoAvailable(undo, prompt)) return
    setPrompt(undo!.before)
    setUndo(null)
    toast('Reverted')
  }

  const chooseExample = (example: ExamplePrompt) => {
    const next = applyExample(example, options)
    setPrompt(next.prompt)
    setOptions(next.options)
    setHistory(historyDeselect)
    setTab('issues')
    editorRef.current?.focus()
  }

  const saveToLibrary = async () => {
    const active = view.active
    if (!active) return
    try {
      await api.library.save({
        original: active.original,
        fixed: active.fixedPrompt,
        summary: active.summary,
        options: active.meta.options,
        scoreBefore: active.before.score,
        scoreAfter: active.after.score,
        provider: active.meta.provider,
        model: active.meta.model,
      })
      setLibraryKey((k) => k + 1)
      toast('Saved to library')
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  const loadEntry = useCallback(
    (entry: LibraryEntry) => {
      setPrompt(entry.original || entry.fixed)
      setHistory(historyDeselect)
      setLibraryOpen(false)
      if (entry.options) setOptions((o) => ({ ...o, ...entry.options }))
      toast('Loaded from library')
    },
    [toast]
  )

  // Stable identities: the drawer keys its fetch effect on these props, and an
  // inline arrow here re-ran that fetch on every App render (and looped on error).
  const closeLibrary = useCallback(() => setLibraryOpen(false), [])
  const onLibraryError = useCallback((m: string) => toast(m, 'error'), [toast])
  const onLibraryNotice = useCallback((m: string) => toast(m), [toast])

  const set = <K extends keyof FixOptions>(key: K, value: FixOptions[K]) =>
    setOptions((o) => ({ ...o, [key]: value }))

  // --- render -------------------------------------------------------------
  if (configError) {
    return (
      <div className="empty" style={{ height: '100vh' }}>
        <div className="big">⚠</div>
        <h3>Cannot reach the PromptFixer server</h3>
        <p>{configError}</p>
        <p>
          Start it with <code>npm run dev</code> in the project folder.
        </p>
      </div>
    )
  }

  if (!config) {
    return (
      <div className="empty" style={{ height: '100vh' }}>
        <div className="spinner dim" />
      </div>
    )
  }

  const { shown, active } = view
  const exampleRows = (
    <div className="example-list" aria-label="Example prompts" data-testid="example-gallery">
      {examples.map((ex) => (
        <button
          className="example-row"
          key={ex.id}
          type="button"
          onClick={() => chooseExample(ex)}
          title={ex.useCase}
        >
          <span className="example-name">{ex.name}</span>
          <span className="example-hint">{ex.useCase}</span>
        </button>
      ))}
    </div>
  )
  const editedNotice = (
    <div className="empty">
      <div className="big">✎</div>
      <h3>Prompt edited</h3>
      <p>
        The last fix was for an earlier version of this prompt. The Issues tab now scores what
        is in the editor.
      </p>
      <button className="btn sm" onClick={() => setShowLastFix(true)}>
        Show last fix
      </button>
    </div>
  )

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark">P</span>
          PromptFixer
          <small>lint · score · rewrite</small>
        </div>

        <div className="topbar-spacer" />

        <div className="topbar-group">
          <span
            className={`status-dot ${providerInfo?.configured ? 'ok' : 'bad'}`}
            title={
              providerInfo?.configured
                ? `${providerInfo.label} is configured`
                : `${providerInfo?.label ?? 'Provider'} has no API key`
            }
          />
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value)
              setModel('')
            }}
            aria-label="Provider"
          >
            {config.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {p.configured ? '' : p.id === 'local' ? ' — download needed' : ' — no key'}
              </option>
            ))}
          </select>

          {provider === 'local' ? (
            <select
              value={model}
              // The tier-sync effect pushes the choice to the server.
              onChange={(e) => setModel(e.target.value)}
              aria-label="Local model tier"
              disabled={!localStatus || localStatus.phase === 'downloading' || localStatus.phase === 'loading'}
              style={{ maxWidth: 260 }}
            >
              {(localStatus?.catalog ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                  {c.downloaded ? ' ✓' : ` · ${gb(c.bytes)} GB`}
                  {c.recommended ? ' (recommended)' : ''}
                </option>
              ))}
            </select>
          ) : (
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              aria-label="Model"
              disabled={modelsLoading || !models.length}
              style={{ maxWidth: 230 }}
            >
              {modelsLoading && <option>Loading models…</option>}
              {!modelsLoading && !models.length && <option value="">No models</option>}
              {!modelsLoading &&
                models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
            </select>
          )}

          <button className="btn" onClick={() => setLibraryOpen(true)}>
            Library
          </button>
        </div>
      </header>

      <div className="main">
        {/* ---------------- input pane ---------------- */}
        <section className="pane">
          <div className="pane-head">
            <span className="pane-title">Your prompt</span>
            <div className="topbar-spacer" />
            {undoAvailable(undo, prompt) && (
              <button className="btn ghost sm" onClick={undoApply}>
                Undo
              </button>
            )}
            {examples.length > 0 ? (
              <select
                className="example-select"
                value=""
                aria-label="Try an example"
                onChange={(e) => {
                  const ex = examples.find((x) => x.id === e.target.value)
                  if (ex) chooseExample(ex)
                }}
              >
                <option value="">Try an example…</option>
                {examples.map((ex) => (
                  <option key={ex.id} value={ex.id} title={ex.useCase}>
                    {ex.name}
                  </option>
                ))}
              </select>
            ) : (
              !prompt && (
                <button className="btn ghost sm" onClick={() => setPrompt(SAMPLE)}>
                  Try a sample
                </button>
              )
            )}
            {prompt && (
              <button
                className="btn ghost sm"
                onClick={() => {
                  setPrompt('')
                  setHistory(historyDeselect)
                }}
              >
                Clear
              </button>
            )}
          </div>

          <div className="pane-body">
            <textarea
              ref={editorRef}
              className="editor"
              data-testid="editor"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={
                'Paste the prompt you want to improve.\n\nAnything works — a one-liner, a system prompt, a half-written idea.\n\nCtrl+Enter to fix.'
              }
              spellCheck={false}
              maxLength={config.limits.maxPromptChars}
            />
          </div>

          <div className="pane-foot">
            <div className="metastrip" data-testid="live-score">
              <span>
                <b>{analysis?.stats.words ?? 0}</b> words
              </span>
              <span>
                ~<b>{analysis?.stats.estimatedTokens ?? 0}</b> tokens
              </span>
              {analysis && (
                <span>
                  score <b style={{ color: 'var(--text)' }}>{analysis.score}</b>/100
                </span>
              )}
              {analysis && analysis.issues.length > 0 && (
                <span>
                  <b>{analysis.issues.length}</b> issue{analysis.issues.length === 1 ? '' : 's'}
                </span>
              )}
              {provider === 'local' && localStatus?.phase === 'ready' && (
                <span
                  className="local-chip"
                  title={localStatus.device ? `${localStatus.gpu} · ${localStatus.device}` : 'CPU'}
                >
                  <b>{localStatus.model.label}</b>
                  {' · '}
                  {localStatus.gpu && localStatus.gpu !== 'cpu' ? String(localStatus.gpu).toUpperCase() : 'CPU'}
                  {localStatus.lastRun?.tokensPerSecond != null &&
                    ` · ${localStatus.lastRun.tokensPerSecond} tok/s`}
                </span>
              )}
            </div>

            <div className="presets">
              <div className="field">
                <label htmlFor="intent">Task type</label>
                <select
                  id="intent"
                  value={options.intent}
                  onChange={(e) => set('intent', e.target.value)}
                >
                  {config.presets.intents.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="target">Target model</label>
                <select
                  id="target"
                  value={options.targetModel}
                  onChange={(e) => set('targetModel', e.target.value)}
                >
                  {config.presets.targetModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="strength">Strength</label>
                <select
                  id="strength"
                  value={options.strength}
                  onChange={(e) => set('strength', e.target.value)}
                >
                  {config.presets.strengths.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="toggle-row">
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={options.preserveTone}
                  onChange={(e) => set('preserveTone', e.target.checked)}
                />
                Keep my voice
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={options.includeExample}
                  onChange={(e) => set('includeExample', e.target.checked)}
                />
                Add an example
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={options.addRole}
                  onChange={(e) => set('addRole', e.target.checked)}
                />
                Add a role line
              </label>
              <label
                className="toggle"
                title="Show the model up to two similar rewrites you saved, so it matches how much you like changed"
              >
                <input
                  type="checkbox"
                  checked={options.fewShot}
                  onChange={(e) => set('fewShot', e.target.checked)}
                />
                Use my library as examples
              </label>
              <button
                className="btn ghost sm"
                onClick={() => setShowNotes((s) => !s)}
                aria-expanded={showNotes}
              >
                {showNotes ? '− Instructions' : '+ Instructions'}
              </button>
            </div>

            {showNotes && (
              <input
                className="notes-input"
                type="text"
                value={options.notes}
                onChange={(e) => set('notes', e.target.value)}
                placeholder="Anything specific? e.g. “keep it under 100 words”, “output must be JSON”"
              />
            )}

            <div className="action-row">
              <button className="btn primary" onClick={runFix} disabled={!canFix}>
                {fixing ? (
                  <>
                    <span className="spinner" /> Fixing…
                  </>
                ) : cancelling ? (
                  <>
                    <span className="spinner" /> Stopping…
                  </>
                ) : (
                  <>Fix prompt {!fixing && <span style={{ opacity: 0.6 }}>⌃⏎</span>}</>
                )}
              </button>
              {fixing && (
                <button className="btn" onClick={cancelFix}>
                  Cancel
                </button>
              )}
            </div>
          </div>
        </section>

        {/* ---------------- result pane ---------------- */}
        <section className="pane">
          <div className="pane-head">
            <div className="tabs" role="tablist">
              <button
                className="tab"
                role="tab"
                aria-selected={tab === 'fixed'}
                onClick={() => setTab('fixed')}
              >
                Fixed
              </button>
              <button
                className="tab"
                role="tab"
                aria-selected={tab === 'diff'}
                onClick={() => setTab('diff')}
              >
                Diff
              </button>
              <button
                className="tab"
                role="tab"
                aria-selected={tab === 'issues'}
                onClick={() => setTab('issues')}
              >
                Issues
                {!!shown?.issues.length && <span className="count">{shown.issues.length}</span>}
              </button>
              <button
                className="tab"
                role="tab"
                aria-selected={tab === 'notes'}
                onClick={() => setTab('notes')}
              >
                Changes
                {!!active?.changes.length && <span className="count">{active.changes.length}</span>}
              </button>
            </div>

            <div className="topbar-spacer" />

            {history.items.length > 0 && (
              <div className="history-nav" aria-label="Fix history">
                <button
                  className="btn ghost sm"
                  onClick={() => stepHistory(-1)}
                  disabled={!nav.canPrev}
                  aria-label="Previous fix"
                  title="Previous fix"
                >
                  ‹
                </button>
                <span className="history-count">{nav.label}</span>
                <button
                  className="btn ghost sm"
                  onClick={() => stepHistory(1)}
                  disabled={!nav.canNext}
                  aria-label="Next fix"
                  title="Next fix"
                >
                  ›
                </button>
              </div>
            )}

            {active && (
              <>
                <button className="btn sm" onClick={() => copy(active.fixedPrompt)}>
                  Copy
                </button>
                <button className="btn sm" onClick={applyFix}>
                  Apply
                </button>
                <button className="btn sm" onClick={saveToLibrary}>
                  Save
                </button>
              </>
            )}
          </div>

          <div className="pane-body">
            {error && (
              <div className="banner error" ref={errorRef}>
                <span>✕</span>
                <div className="banner-body">
                  <strong>Could not fix the prompt</strong>
                  {error}
                </div>
              </div>
            )}

            {provider === 'local' && localStatus && localStatus.phase !== 'ready' && !error && (
              <div className={`banner ${localStatus.phase === 'error' ? 'error' : 'info'}`}>
                <span>◉</span>
                <div className="banner-body">
                  {localStatus.phase === 'missing' && (
                    <>
                      <strong>Download the local model</strong>
                      {localStatus.model.label} · {gb(localStatus.model.bytes)} GB · one-time download,
                      then everything runs offline. Saved to <code>{localStatus.modelDir}</code>.
                      <div className="actions">
                        <button
                          className="btn primary sm"
                          onClick={() =>
                            api.local
                              .download(model || undefined)
                              .then(setLocalStatus)
                              .then(() => setLocalTick((t) => t + 1))
                              .catch((err) => toast((err as Error).message, 'error'))
                          }
                        >
                          Download {gb(localStatus.model.bytes)} GB
                        </button>
                        <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
                          {localStatus.model.blurb}
                        </span>
                      </div>
                    </>
                  )}
                  {localStatus.phase === 'downloading' && (
                    <>
                      <strong>Downloading {localStatus.model.label}…</strong>
                      <div className="progress">
                        <div className="bar" style={{ width: `${localStatus.progress.percent}%` }} />
                      </div>
                      <div className="actions">
                        <span className="metastrip">
                          <b>{localStatus.progress.percent}%</b>
                          <span>
                            {gb(localStatus.progress.downloaded)} / {gb(localStatus.progress.total)} GB
                          </span>
                        </span>
                        <button
                          className="btn ghost sm"
                          onClick={() =>
                            api.local
                              .cancel()
                              .then(setLocalStatus)
                              .then(() => setLocalTick((t) => t + 1))
                          }
                        >
                          Pause
                        </button>
                      </div>
                    </>
                  )}
                  {localStatus.phase === 'downloaded' && (
                    <>
                      <strong>{localStatus.model.label} is on disk</strong>
                      It loads into memory on your first fix — a few seconds — and stays loaded.
                      <div className="actions">
                        <button
                          className="btn sm"
                          onClick={() => {
                            api.local
                              .load()
                              .then(setLocalStatus)
                              .catch((err) => toast((err as Error).message, 'error'))
                            setLocalTick((t) => t + 1)
                          }}
                        >
                          Load now
                        </button>
                      </div>
                    </>
                  )}
                  {localStatus.phase === 'loading' && (
                    <>
                      <strong>Loading {localStatus.model.label} into memory…</strong>
                      <div className="actions">
                        <span className="spinner dim" /> Detecting GPU and allocating context.
                      </div>
                    </>
                  )}
                  {localStatus.phase === 'error' && (
                    <>
                      <strong>Local model problem</strong>
                      {localStatus.error}
                      <div className="actions">
                        <button
                          className="btn sm"
                          onClick={() =>
                            (localStatus.downloaded ? api.local.load() : api.local.download(model || undefined))
                              .then(setLocalStatus)
                              .then(() => setLocalTick((t) => t + 1))
                              .catch((err) => toast((err as Error).message, 'error'))
                          }
                        >
                          Retry
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}

            {modelsError && !error && (
              <div className="banner warn">
                <span>◆</span>
                <div className="banner-body">
                  <strong>Could not list models for {providerInfo?.label}</strong>
                  {modelsError}
                  {provider === 'ollama' && (
                    <>
                      {' '}Start it with <code>ollama serve</code>, then pull a model, e.g.{' '}
                      <code>ollama pull llama3.1</code>.
                    </>
                  )}
                </div>
              </div>
            )}

            {!anyConfigured && !modelsError && !error && provider !== 'local' && (
              <div className="banner warn">
                <span>◆</span>
                <div className="banner-body">
                  <strong>No provider key configured</strong>
                  Linting and scoring work offline. For AI rewrites, copy <code>.env.example</code> to{' '}
                  <code>.env</code>, add a key, and restart the server — or select{' '}
                  <b>Ollama</b> to run fully local.
                </div>
              </div>
            )}

            {view.edited && active && tab !== 'issues' && (
              <div className="banner info">
                <span>✎</span>
                <div className="banner-body">
                  <strong>Showing the fix for an earlier version of the prompt</strong>
                  The editor has changed since this rewrite was made. Apply still replaces the
                  editor with it.
                  <div className="actions">
                    <button
                      className="btn ghost sm"
                      onClick={() => {
                        setShowLastFix(false)
                        setPinned(false)
                      }}
                    >
                      Hide
                    </button>
                  </div>
                </div>
              </div>
            )}

            {tab === 'issues' &&
              (shown ? (
                <>
                  <ScorePanel
                    analysis={shown}
                    categories={config.categories}
                    compareTo={view.compareTo}
                  />
                  <IssueList analysis={shown} categories={config.categories} />
                </>
              ) : (
                <div className="empty">
                  <div className="big">◑</div>
                  <h3>Start typing</h3>
                  <p>
                    Your prompt is scored as you write, with no API call. Hit <b>Fix prompt</b> when
                    you want a rewrite.
                  </p>
                  {!prompt && examples.length > 0 && (
                    <>
                      <p>Or start from an example:</p>
                      {exampleRows}
                    </>
                  )}
                </div>
              ))}

            {tab === 'fixed' && view.edited && !active && editedNotice}
            {tab === 'fixed' &&
              (active ? (
                <>
                  {active.meta.warning && (
                    <div className="banner warn">
                      <span>▲</span>
                      <div className="banner-body">
                        <strong>{warningHeadline(active.meta)}</strong>
                        {active.meta.warning}
                      </div>
                    </div>
                  )}
                  {!active.meta.warning && active.after.score < active.before.score && (
                    <div className="banner warn">
                      <span>▼</span>
                      <div className="banner-body">
                        <strong>Scored lower than your original</strong>
                        The rewrite lost {active.before.score - active.after.score} points. The Diff tab
                        shows what changed; the Issues tab shows why. Light touch keeps more of your
                        wording, and the original is one click away with Clear.
                      </div>
                    </div>
                  )}
                  {active.summary && (
                    <div className="banner info" data-testid="what-changed">
                      <span>✦</span>
                      <div className="banner-body">
                        <strong>What changed</strong>
                        {active.summary}
                        {active.meta.attempts > 1 && !active.meta.warning && (
                          <span style={{ color: 'var(--text-faint)' }}>
                            {' '}
                            (first attempt rewrote too much; kept the retry)
                          </span>
                        )}
                        {learnedNote(active.meta) && (
                          <span style={{ color: 'var(--text-faint)' }}>{learnedNote(active.meta)}</span>
                        )}
                        {refinedNote(active.meta) && (
                          <span style={{ color: 'var(--text-faint)' }}>{refinedNote(active.meta)}</span>
                        )}
                      </div>
                    </div>
                  )}
                  <ScorePanel
                    analysis={active.after}
                    categories={config.categories}
                    compareTo={active.before}
                  />
                  <MarkableOutput
                    text={active.fixedPrompt}
                    marks={marks}
                    onMarksChange={(next) => setMarked(next.length ? { result: active, marks: next } : null)}
                    canRefine={canRefine}
                    refining={refining}
                    onRefine={runRefine}
                  />
                </>
              ) : view.edited ? null : (
                <div className="empty">
                  <div className="big">✦</div>
                  <h3>No rewrite yet</h3>
                  <p>Press Fix prompt to get an improved version you can copy straight out.</p>
                </div>
              ))}

            {tab === 'diff' && view.edited && !active && editedNotice}
            {tab === 'diff' &&
              (active ? (
                <DiffView before={active.original} after={active.fixedPrompt} />
              ) : view.edited ? null : (
                <div className="empty">
                  <div className="big">⇄</div>
                  <h3>Nothing to compare</h3>
                  <p>The diff shows exactly which words the fixer added and removed.</p>
                </div>
              ))}

            {tab === 'notes' && view.edited && !active && editedNotice}
            {tab === 'notes' &&
              (active ? (
                <div>
                  <div className="section">
                    <div className="section-title">
                      Changes
                      <Delta before={active.before.score} after={active.after.score} />
                    </div>
                    <div className="card" data-testid="changes">
                      {active.changes.length ? (
                        active.changes.map((c, i) => (
                          <div className="change" key={i}>
                            <span className="pill cat">{c.type}</span>
                            <span className="change-what">{c.what}</span>
                            {c.why && <span className="change-why">{c.why}</span>}
                          </div>
                        ))
                      ) : (
                        <span style={{ color: 'var(--text-faint)' }}>
                          The model did not itemise its changes. Check the diff tab.
                        </span>
                      )}
                    </div>
                  </div>

                  {active.assumptions.length > 0 && (
                    <div className="section">
                      <div className="section-title">Assumptions made</div>
                      <ul className="bullets">
                        {active.assumptions.map((a, i) => (
                          <li key={i}>{a}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {active.questions.length > 0 && (
                    <div className="section">
                      <div className="section-title">Answer these to go further</div>
                      <ul className="bullets">
                        {active.questions.map((q, i) => (
                          <li key={i}>{q}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {active.techniques.length > 0 && (
                    <div className="section">
                      <div className="section-title">Techniques applied</div>
                      <div className="chips">
                        {active.techniques.map((t) => (
                          <span className="chip" key={t}>
                            {t}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="section">
                    <div className="section-title">Run details</div>
                    <div className="metastrip" data-testid="run-details">
                      <span>
                        <b>{active.meta.model}</b>
                      </span>
                      <span>{(active.meta.elapsedMs / 1000).toFixed(1)}s</span>
                      {active.meta.usage?.inputTokens != null && (
                        <span>
                          {active.meta.usage.inputTokens} in / {active.meta.usage.outputTokens} out
                        </span>
                      )}
                      <span>
                        {active.before.stats.words} → {active.after.stats.words} words
                      </span>
                    </div>
                  </div>
                </div>
              ) : view.edited ? null : (
                <div className="empty">
                  <div className="big">☰</div>
                  <h3>No run yet</h3>
                  <p>After a fix, this tab explains every change and what it prevents.</p>
                </div>
              ))}
          </div>
        </section>
      </div>

      {libraryOpen && (
        <Library
          onClose={closeLibrary}
          onLoad={loadEntry}
          refreshKey={libraryKey}
          onError={onLibraryError}
          onNotice={onLibraryNotice}
        />
      )}

      <div className="toasts" data-testid="toasts">
        {toasts.map((t) => (
          <div className={`toast ${t.kind}`} key={t.id}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  )
}
