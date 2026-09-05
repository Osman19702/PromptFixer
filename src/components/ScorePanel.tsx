import type { Analysis, AppConfig, CategoryKey } from '../types'

const color = (score: number) =>
  score >= 80 ? 'var(--good)' : score >= 55 ? 'var(--warn)' : 'var(--bad)'

export function Delta({ before, after }: { before: number; after: number }) {
  const diff = after - before
  const dir = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat'
  return (
    <span className={`delta ${dir}`}>
      {diff > 0 ? '▲' : diff < 0 ? '▼' : '—'} {diff > 0 ? '+' : ''}
      {diff === 0 ? 'no change' : diff}
    </span>
  )
}

interface Props {
  analysis: Analysis
  categories: AppConfig['categories']
  compareTo?: Analysis | null
}

export function ScorePanel({ analysis, categories, compareTo }: Props) {
  const keys = Object.keys(categories) as CategoryKey[]

  return (
    <div className="scorecard">
      <div
        className="dial"
        style={
          {
            '--pct': analysis.score,
            '--dial': color(analysis.score),
          } as React.CSSProperties
        }
        role="img"
        aria-label={`Prompt score ${analysis.score} out of 100, grade ${analysis.grade}`}
      >
        <div className="dial-value">
          {analysis.score}
          <span>/100</span>
        </div>
      </div>

      <div className="score-bars">
        {keys.map((key) => {
          const value = analysis.categories[key] ?? 0
          return (
            <div className="score-bar" key={key} title={categories[key].blurb}>
              <span>{categories[key].label}</span>
              <div className="track">
                <div
                  className="fill"
                  style={{ width: `${value}%`, background: color(value) }}
                />
              </div>
              <span>{value}</span>
            </div>
          )
        })}
      </div>

      {compareTo && (
        <div style={{ textAlign: 'right', display: 'grid', gap: 6, flex: '0 0 auto' }}>
          <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>
            was <b style={{ color: 'var(--text-dim)' }}>{compareTo.score}</b>
          </div>
          <Delta before={compareTo.score} after={analysis.score} />
        </div>
      )}
    </div>
  )
}
