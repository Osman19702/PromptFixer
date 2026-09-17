import { useMemo, useState } from 'react'
import { diffStats, diffText } from '../lib/diff'

export function DiffView({ before, after }: { before: string; after: string }) {
  const [showRemoved, setShowRemoved] = useState(true)
  const { tokens, degraded } = useMemo(() => diffText(before, after), [before, after])
  const stats = useMemo(() => diffStats(tokens), [tokens])

  return (
    <div>
      <div
        className="difflegend"
        style={{ marginBottom: 12, justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}
      >
        <div style={{ display: 'flex', gap: 14 }}>
          <span>
            <i style={{ background: 'rgba(62,207,142,.5)' }} />
            {stats.added} added
          </span>
          <span>
            <i style={{ background: 'rgba(242,97,107,.5)' }} />
            {stats.removed} removed
          </span>
          <span>{stats.unchanged} kept</span>
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={showRemoved}
            onChange={(e) => setShowRemoved(e.target.checked)}
          />
          Show removed text
        </label>
      </div>

      {degraded && (
        <div className="banner info" role="status">
          <span>≈</span>
          <div className="banner-body">
            <strong>Part of this diff is sentence-level</strong>
            A stretch of text was too long to compare word by word, so it is shown as whole
            sentences removed and added. The counts above include those sentences.
          </div>
        </div>
      )}

      <div className={`diff ${showRemoved ? '' : 'hide-removed'}`} data-testid="diff">
        {tokens.map((token, i) => {
          if (token.type === 'add') return <ins key={i}>{token.value}</ins>
          if (token.type === 'del') return <del key={i}>{token.value}</del>
          return <span key={i}>{token.value}</span>
        })}
      </div>
    </div>
  )
}
