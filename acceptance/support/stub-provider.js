/**
 * A scriptable stand-in for an OpenAI-compatible provider.
 *
 * Scenarios queue replies explicitly (`stub.queue(reply, reply, …)`) instead of
 * smuggling markers through the prompt text, so a scenario reads "given the
 * model returns a different prompt, then a faithful edit" rather than "given
 * the prompt contains ALWAYS_DIVERGE". When the queue is empty the stub
 * answers with the default balanced rewrite from fixtures.js.
 *
 * Every request the server makes is recorded in `stub.requests`, parsed into
 * the things a scenario can legitimately observe: the original prompt the
 * model was asked to fix, whether it was a corrective retry, which linter
 * findings it was shown, how many library examples it was shown, and whether
 * the server abandoned the connection.
 */

import http from 'node:http'

import { FIX_RESPONSE } from './fixtures.js'

/**
 * A reply spec (`{ json }`, `{ status }`, `{ stall }`, …), or a function of the
 * parsed request that returns the model's JSON answer directly.
 */
const normalise = (spec, record) => (typeof spec === 'function' ? { json: spec(record) } : spec)

function parseFindings(user) {
  const block = user.match(/<linter_findings>\n([\s\S]*?)\n<\/linter_findings>/)?.[1] || ''
  return block
    .split('\n')
    .map((l) => l.match(/^- \[(\w+)\/(\w+)\] ([^:]+):/))
    .filter(Boolean)
    .map((m) => ({ severity: m[1], category: m[2], title: m[3].trim() }))
}

export async function startStub() {
  const requests = []
  let queued = []
  let modelsReply = { models: ['stub-large', 'stub-small'] }

  const server = http.createServer((req, res) => {
    if (req.url === '/models') {
      if (modelsReply.status) {
        res.writeHead(modelsReply.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: modelsReply.message || 'nope' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: modelsReply.models.map((id) => ({ id })) }))
      return
    }
    if (req.url !== '/chat/completions') {
      res.writeHead(404)
      res.end('{}')
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = JSON.parse(body)
      const system = parsed.messages?.[0]?.content || ''
      const user = parsed.messages?.[1]?.content || ''
      const record = {
        model: parsed.model,
        authorization: req.headers.authorization || null,
        system,
        user,
        original: user.match(/<original_prompt>\n([\s\S]*?)\n<\/original_prompt>/)?.[1] || '',
        isRetry: user.includes('<rejected_attempt>'),
        rejectedReasons: user.match(/Your previous attempt was rejected: ([^\n]*)/)?.[1] || '',
        findings: parseFindings(user),
        examples: (user.match(/<example>/g) || []).length,
        exampleTexts: [...user.matchAll(/<before>([\s\S]*?)<\/before>/g)].map((m) => m[1]),
        exampleAfters: [...user.matchAll(/<after>([\s\S]*?)<\/after>/g)].map((m) => m[1]),
        notes: user.match(/<user_notes>\n([\s\S]*?)\n<\/user_notes>/)?.[1] || '',
        upstreamAborted: false,
      }
      requests.push(record)
      // The body has been read in full by now, so a server that gives up on us
      // shows as the connection closing before we have answered.
      req.on('close', () => {
        if (!res.writableFinished) record.upstreamAborted = true
      })

      const spec = normalise(queued.length ? queued.shift() : { json: FIX_RESPONSE }, record)

      const respond = () => {
        if (spec.stall === 'headers') return // never answer
        if (spec.status) {
          res.writeHead(spec.status, { 'content-type': spec.contentType || 'application/json' })
          res.end(spec.body ?? JSON.stringify({ error: { message: spec.message || 'upstream failure' } }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        const payload = JSON.stringify({
          model: parsed.model,
          choices: [
            {
              message: { content: '```json\n' + JSON.stringify(spec.json) + '\n```' },
              finish_reason: spec.finishReason || 'stop',
            },
          ],
          usage: { prompt_tokens: 812, completion_tokens: 204 },
        })
        if (spec.stall === 'body') {
          res.write(payload.slice(0, 20)) // headers and a fragment, then silence
          return
        }
        res.end(payload)
      }
      if (spec.delayMs) setTimeout(respond, spec.delayMs)
      else respond()
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    /** Queue replies for the next N completions, in order. */
    queue(...specs) {
      queued.push(...specs)
    },
    /** What GET /models answers: `{ models: [...] }` or `{ status: 401 }`. */
    models(reply) {
      modelsReply = reply
    },
    /** Forget queued replies and recorded requests; call between scenarios. */
    reset() {
      queued = []
      requests.length = 0
      modelsReply = { models: ['stub-large', 'stub-small'] }
    },
    /** The most recent completion request, or null. */
    last: () => requests[requests.length - 1] || null,
    close: () =>
      new Promise((resolve) => {
        // A scenario may have left a deliberately stalled response open.
        server.closeAllConnections()
        server.close(resolve)
      }),
  }
}
