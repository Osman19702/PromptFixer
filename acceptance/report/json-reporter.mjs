/**
 * node:test reporter that writes one JSON document of top-level results:
 * name, file, status (pass | fail | todo | skip), duration and the failure
 * message. Used by `npm run test:report` to build the results PDF.
 */

export default async function* jsonReporter(source) {
  const results = []
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue
    const d = event.data
    if (d.nesting !== 0) continue
    const error = d.details?.error
    const cause = error?.cause ?? error
    results.push({
      name: d.name,
      file: d.file ? String(d.file).replace(/\\/g, '/').split('/').pop() : null,
      status: event.type === 'test:fail' ? 'fail' : d.todo ? 'todo' : d.skip ? 'skip' : 'pass',
      note: typeof d.todo === 'string' ? d.todo : typeof d.skip === 'string' ? d.skip : null,
      durationMs: Math.round(d.details?.duration_ms ?? 0),
      error: error ? String(cause?.message || error.message || error).split('\n').slice(0, 12).join('\n') : null,
    })
  }
  yield JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)
}
