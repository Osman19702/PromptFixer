import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { activatesEntry, exportFilename, importSummary, parseImportFile } from '../lib/ui'
import type { LibraryEntry } from '../types'

interface Props {
  onClose: () => void
  onLoad: (entry: LibraryEntry) => void
  refreshKey: number
  onError: (message: string) => void
  /** Non-error feedback, e.g. the import counts. */
  onNotice?: (message: string) => void
}

export function Library({ onClose, onLoad, refreshKey, onError, onNotice }: Props) {
  const [entries, setEntries] = useState<LibraryEntry[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  // Bumped after an import so the list refetches without the parent's key.
  const [imported, setImported] = useState(0)
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)

  // Read through a ref so a caller passing a fresh arrow each render cannot
  // retrigger the fetch; before this, a failing list call looped forever
  // (error -> toast -> parent re-render -> new onError -> refetch).
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const onNoticeRef = useRef(onNotice)
  onNoticeRef.current = onNotice

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const timer = setTimeout(() => {
      api.library
        .list(query)
        .then((res) => {
          if (!cancelled) setEntries(res.entries)
        })
        .catch((err) => !cancelled && onErrorRef.current(err.message))
        .finally(() => !cancelled && setLoading(false))
    }, query ? 220 : 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, refreshKey, imported])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const remove = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await api.library.remove(id)
      setEntries((prev) => prev.filter((entry) => entry.id !== id))
    } catch (err) {
      onErrorRef.current((err as Error).message)
    }
  }

  // fetch cannot open a save dialog, so the export JSON is wrapped in a Blob
  // and clicked through an anchor whose download name mirrors the server's
  // Content-Disposition header (which a fetch response does not surface).
  const exportAll = async () => {
    setBusy('export')
    try {
      const data = await api.library.export()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = exportFilename(data.exportedAt)
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      onNoticeRef.current?.(`Exported ${data.entries.length} prompt${data.entries.length === 1 ? '' : 's'}`)
    } catch (err) {
      onErrorRef.current((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const importFile = async (file: File | undefined) => {
    if (!file) return
    setBusy('import')
    try {
      const res = await api.library.import(parseImportFile(await file.text()))
      onNoticeRef.current?.(importSummary(res))
      setImported((n) => n + 1)
    } catch (err) {
      onErrorRef.current((err as Error).message)
    } finally {
      setBusy(null)
      // Reset so choosing the same file again fires another change event.
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Prompt library">
        <div className="pane-head">
          <span className="pane-title">Library</span>
          <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
            {entries.length} saved
          </span>
          <div className="topbar-spacer" />
          <button
            className="btn ghost sm"
            onClick={exportAll}
            disabled={busy != null}
            title="Download every saved prompt as JSON"
          >
            {busy === 'export' ? 'Exporting…' : 'Export'}
          </button>
          <button
            className="btn ghost sm"
            onClick={() => fileInput.current?.click()}
            disabled={busy != null}
            title="Add prompts from a PromptFixer export; entries you already have are kept"
          >
            {busy === 'import' ? 'Importing…' : 'Import'}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            tabIndex={-1}
            aria-label="Import library file"
            onChange={(e) => importFile(e.target.files?.[0])}
          />
          <button className="btn ghost sm" onClick={onClose} aria-label="Close library">
            ✕
          </button>
        </div>

        <div style={{ padding: '12px 16px 0' }}>
          <input
            type="text"
            placeholder="Search prompts, tags…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ width: '100%' }}
          />
        </div>

        <div className="pane-body">
          {loading && !entries.length ? (
            <div className="empty">
              <div className="spinner dim" />
            </div>
          ) : entries.length === 0 ? (
            <div className="empty">
              <div className="big">◇</div>
              <h3>{query ? 'No matches' : 'Nothing saved yet'}</h3>
              <p>
                {query
                  ? 'Try a different search term.'
                  : 'Fix a prompt, then hit Save to keep the original and the rewrite together.'}
              </p>
            </div>
          ) : (
            <div className="lib-list">
              {entries.map((entry) => (
                <div
                  className="lib-entry"
                  key={entry.id}
                  onClick={() => onLoad(entry)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    // Keys pressed on the nested Delete button bubble up here;
                    // only the wrapper's own Enter/Space should load the entry.
                    if (!activatesEntry(e)) return
                    e.preventDefault()
                    onLoad(entry)
                  }}
                >
                  <div className="lib-entry-title">{entry.title}</div>
                  <div className="lib-entry-meta">
                    {entry.scoreBefore != null && entry.scoreAfter != null && (
                      <span>
                        {entry.scoreBefore} → <b style={{ color: 'var(--good)' }}>{entry.scoreAfter}</b>
                      </span>
                    )}
                    {entry.model && <span className="chip">{entry.model}</span>}
                    <span>{new Date(entry.updatedAt).toLocaleDateString()}</span>
                    <div className="topbar-spacer" />
                    <button
                      className="btn ghost sm"
                      onClick={(e) => remove(entry.id, e)}
                      aria-label={`Delete ${entry.title}`}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
    </>
  )
}
