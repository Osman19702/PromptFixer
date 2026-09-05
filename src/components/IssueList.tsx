import type { Analysis, AppConfig } from '../types'

export function IssueList({
  analysis,
  categories,
}: {
  analysis: Analysis
  categories: AppConfig['categories']
}) {
  if (!analysis.issues.length) {
    return (
      <div className="empty">
        <div className="big">✓</div>
        <h3>No issues found</h3>
        <p>
          The linter has nothing to flag. That does not guarantee a great answer, but the prompt is
          well-formed.
        </p>
      </div>
    )
  }

  const counts = analysis.issues.reduce<Record<string, number>>((acc, i) => {
    acc[i.severity] = (acc[i.severity] ?? 0) + 1
    return acc
  }, {})

  return (
    <div>
      <div className="metastrip" style={{ marginBottom: 12 }}>
        {(['high', 'medium', 'low'] as const).map(
          (sev) =>
            counts[sev] > 0 && (
              <span key={sev}>
                <span className={`pill ${sev}`}>{sev}</span> <b>{counts[sev]}</b>
              </span>
            )
        )}
      </div>

      <div className="issue-list">
        {analysis.issues.map((issue, index) => (
          <details className={`issue ${issue.severity}`} key={`${issue.id}-${index}`} open={index < 3}>
            <summary>
              <span className={`pill ${issue.severity}`}>{issue.severity}</span>
              <span>{issue.title}</span>
            </summary>
            <div className="issue-body">
              <p>{issue.detail}</p>
              <div className="issue-fix">{issue.suggestion}</div>
              {issue.evidence.length > 0 && (
                <div className="evidence">
                  {issue.evidence.map((ev, i) => (
                    <code key={i}>{ev}</code>
                  ))}
                </div>
              )}
              <div>
                <span className="pill cat">{categories[issue.category]?.label ?? issue.category}</span>
              </div>
            </div>
          </details>
        ))}
      </div>

      {analysis.strengths.length > 0 && (
        <div className="section" style={{ marginTop: 20 }}>
          <div className="section-title">Already working</div>
          <div className="chips">
            {analysis.strengths.map((s) => (
              <span className="chip good" key={s}>
                ✓ {s}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
