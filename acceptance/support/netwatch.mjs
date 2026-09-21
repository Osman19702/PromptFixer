/**
 * Records every attempt the process makes to reach an address that is not this
 * machine. Inert unless PROMPTFIXER_NETWATCH_LOG names a file, so leaving it on
 * a command line can never change how the server behaves.
 *
 * Installed through NODE_OPTIONS rather than a bare CLI flag, because the
 * environment is inherited: a worker thread created with `execArgv: []`, and a
 * node child process, both escape `node --import <this>` but still install it
 * when it arrives through NODE_OPTIONS.
 *
 * Everything patched here is reached through createRequire, never through an
 * ESM `import`. A builtin's ESM facade freezes its named exports when it is
 * first instantiated, so patching `dns.lookup` on the namespace object after an
 * `import dns from 'node:dns'` leaves a dependency's `import { lookup } from
 * 'node:dns'` bound to the original. Requiring the CJS module and patching that
 * means the facade, whenever it is built, snapshots the patched functions.
 *
 * What it hooks:
 *
 *   net.Socket.prototype.connect   Every outbound TCP connection in Node ends
 *                                  here — net.connect, tls.connect (TLSSocket
 *                                  inherits this method), http/https.request,
 *                                  global fetch and undici. A prototype method,
 *                                  so a reference captured earlier cannot
 *                                  escape it.
 *   tls.connect                    The one destination the socket layer cannot
 *                                  see: tls.connect({ socket, servername })
 *                                  wraps an already-open socket, which is how a
 *                                  proxy CONNECT tunnel works. The real host
 *                                  exists only as `servername`.
 *   dgram.Socket.prototype.send    UDP, which never touches net.Socket.
 *   dgram.Socket.prototype.connect A connected UDP socket's send() carries no
 *                                  address at all, so the destination has to be
 *                                  remembered from here.
 *   dns.* (the whole family)       dns.resolve* does not go through net.Socket:
 *                                  c-ares builds its own socket in C++. The JS
 *                                  call is the only place it is visible.
 *   child_process                  Both the async funnel and the sync binding.
 *                                  execSync and execFileSync do not call the
 *                                  module's spawnSync export, so patching that
 *                                  alone misses them.
 *
 * Each attempt is appended the moment it happens, never buffered and never
 * written at exit: a killed process runs no exit handler, so an exit-time flush
 * would report silence for a server that had been chattering.
 *
 * WHAT THIS CANNOT SEE, by construction:
 *
 *   - A native addon calling connect(2) from C++ with no JavaScript on the
 *     stack. Not hypothetical here: llama.cpp is a .node binary. The same is
 *     true of the packets c-ares sends for dns.resolve* — the call is recorded,
 *     the packet is not.
 *   - What a child process sends. The spawn is recorded so the gap is loud
 *     rather than silent, but its traffic is beyond reach.
 *   - Bytes on a connection that was already open. This counts connections, not
 *     payloads, which is only sound because the assertion is that no
 *     off-machine connection is opened at all.
 *   - Electron's Chromium network stack. F11 covers the same page code through
 *     Playwright instead.
 *   - A destination reached through an HTTP proxy on loopback. The connection
 *     really is to this machine. F11 refuses to run with proxy variables set
 *     rather than pretend otherwise.
 *
 * docs/PRIVACY.md states these in the same words for a non-developer.
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const fs = require('node:fs')
const net = require('node:net')
const tls = require('node:tls')
const dns = require('node:dns')
const dgram = require('node:dgram')
const childProcess = require('node:child_process')

/**
 * The variables that route a request through a proxy. A proxy on loopback makes
 * every destination in the world look like this machine, so a watched run has
 * to know about them — and a harness blanking them has to blank the same list.
 * One definition, so the two cannot drift apart.
 */
export const PROXY_VARS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'NODE_USE_ENV_PROXY',
  'npm_config_proxy',
]

/** `{ HTTP_PROXY: '', http_proxy: '', … }` — every spelling, blanked. */
export const blankedProxyEnv = () =>
  Object.fromEntries(PROXY_VARS.flatMap((name) => [[name, ''], [name.toLowerCase(), '']]))

/** One line per JSON object: the wire format of both the log and /api/fix. */
export const parseNdjson = (text) =>
  String(text)
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))

const LOG = process.env.PROMPTFIXER_NETWATCH_LOG
if (LOG) install(LOG)

/** Addresses that are this machine, and therefore not "leaving" it. */
export function isLocal(host) {
  if (host === undefined || host === null || host === '') return true
  const h = String(host).trim().toLowerCase().replace(/^\[|\]$/g, '')
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '::1' ||
    h === '0:0:0:0:0:0:0:1' ||
    h === '::' ||
    h === '0.0.0.0' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) ||
    /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  )
}

/**
 * A unix socket or named pipe is this machine — except a Windows UNC path,
 * which names another host and carries bytes over SMB.
 */
export function isLocalPath(p) {
  const s = String(p)
  if (!s.startsWith('\\\\')) return true
  // \\.\pipe\… and \\?\… are local device namespaces; \\server\share is not.
  return /^\\\\[.?]\\/.test(s)
}

/** The frames of our own code that led here, so a failure names a culprit. */
function blame() {
  return (new Error().stack || '')
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => !line.includes('netwatch') && !line.startsWith('at node:'))
    .slice(0, 4)
    .join(' <- ')
}

function install(logPath) {
  const write = (entry) => {
    try {
      fs.appendFileSync(logPath, `${JSON.stringify({ ...entry, stack: blame() })}\n`)
    } catch {
      // A watcher that throws would fail the process it is only observing.
    }
  }
  const record = (kind, host, port) => {
    if (isLocal(host)) return
    write({ kind, host: String(host), port: port ?? null })
  }

  // A proxy on loopback makes real egress look local, so refuse to be trusted
  // in an environment where that is possible rather than report a clean run.
  for (const name of PROXY_VARS) {
    for (const key of [name, name.toLowerCase()]) {
      if (process.env[key]) write({ kind: 'proxy', host: `${key}=${process.env[key]}`, port: null })
    }
  }

  // --- TCP and TLS -----------------------------------------------------------
  // net._normalizeArgs handles all six call shapes — (port, host), (options),
  // the pre-normalised [options, cb] array net.connect() produces, and a port
  // given as a string, which a WHATWG URL's .port always is. Hand-rolling this
  // is how a string port slips through unrecorded.
  // No fallback on purpose. If a future Node drops _normalizeArgs this throws
  // and the acceptance run fails loudly; degrading to hand-rolled parsing would
  // silently reintroduce the string-port hole, in a watcher whose entire value
  // is that an empty log means something.
  const shapeOf = (args) => net._normalizeArgs(Array.isArray(args[0]) ? args[0] : args)[0]

  const connect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function (...args) {
    const o = shapeOf(args)
    if (o.path !== undefined && o.path !== null) {
      if (!isLocalPath(o.path)) write({ kind: 'unc', host: String(o.path), port: null })
    } else {
      record('tcp', o.host ?? o.hostname, o.port)
    }
    return connect.apply(this, args)
  }

  const tlsConnect = tls.connect
  tls.connect = function (...args) {
    const o = args.find((a) => a && typeof a === 'object') || {}
    // With an existing socket there is no host here, and the destination of a
    // CONNECT tunnel appears nowhere else.
    record('tls', o.servername ?? o.host ?? o.hostname, o.port)
    return tlsConnect.apply(this, args)
  }

  // --- UDP -------------------------------------------------------------------
  const connectedTo = new WeakMap()
  const dgramConnect = dgram.Socket.prototype.connect
  dgram.Socket.prototype.connect = function (port, address, ...rest) {
    connectedTo.set(this, { port, address })
    record('udp', address ?? '127.0.0.1', port)
    return dgramConnect.call(this, port, address, ...rest)
  }

  const send = dgram.Socket.prototype.send
  dgram.Socket.prototype.send = function (...args) {
    const tail = args.slice(1)
    const address = [...tail].reverse().find((a) => typeof a === 'string')
    const port = tail.find((a) => typeof a === 'number')
    if (address !== undefined) {
      record('udp', address, port)
    } else {
      // A connected socket's send() names no destination; use the remembered one.
      const remote = connectedTo.get(this)
      if (remote) record('udp', remote.address, remote.port)
    }
    return send.apply(this, args)
  }

  // --- DNS -------------------------------------------------------------------
  const wrapHost = (target, name) => {
    if (!target) return
    const real = target[name]
    if (typeof real !== 'function') return
    target[name] = function (hostname, ...rest) {
      record('dns', hostname)
      return real.call(this, hostname, ...rest)
    }
  }
  const RESOLVERS = [
    'lookup',
    'lookupService',
    'resolve',
    'resolve4',
    'resolve6',
    'resolveAny',
    'resolveCaa',
    'resolveCname',
    'resolveMx',
    'resolveNaptr',
    'resolveNs',
    'resolvePtr',
    'resolveSoa',
    'resolveSrv',
    'resolveTxt',
    'reverse',
  ]
  for (const name of RESOLVERS) {
    wrapHost(dns, name)
    wrapHost(dns.promises, name)
    wrapHost(dns.Resolver?.prototype, name)
    wrapHost(dns.promises?.Resolver?.prototype, name)
  }

  // --- child processes -------------------------------------------------------
  const noteSpawn = (how, command) => write({ kind: 'spawn', how, host: String(command ?? '?'), port: null })

  const asyncSpawn = childProcess.ChildProcess.prototype.spawn
  childProcess.ChildProcess.prototype.spawn = function (options) {
    noteSpawn('spawn', options?.file)
    return asyncSpawn.call(this, options)
  }

  // execSync and execFileSync call the binding directly, not the module's
  // spawnSync export, so the export alone misses them.
  try {
    const binding = process.binding('spawn_sync')
    const realSync = binding.spawn
    binding.spawn = function (options) {
      noteSpawn('spawnSync', options?.file)
      return realSync.call(this, options)
    }
  } catch {
    // process.binding is deprecated and may be gone; the export below still
    // covers a direct spawnSync call.
  }
  const spawnSync = childProcess.spawnSync
  childProcess.spawnSync = function (command, ...rest) {
    noteSpawn('spawnSync', command)
    return spawnSync.call(this, command, ...rest)
  }
}

/**
 * Run `source` in a fresh node process under this watcher and return everything
 * it recorded. Used by the tests, not by the watcher.
 *
 * Installed through NODE_OPTIONS, the way acceptance/support/app.js installs it,
 * so a probe exercises the real installation path rather than a weaker one —
 * a command-line --import does not survive a worker with `execArgv: []` or a
 * spawned node child, and a self-check that proves the wrong path proves little.
 */
export async function runWatched(source, { env = {} } = {}) {
  const os = require('node:os')
  const path = require('node:path')
  const log = path.join(os.tmpdir(), `netwatch-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`)
  fs.writeFileSync(log, '')
  try {
    await new Promise((resolve) => {
      // Probes leave sockets and handles open, which would keep the process
      // alive for ever. Every attempt is appended synchronously as it happens,
      // so exiting immediately loses nothing.
      const child = childProcess.spawn(
        process.execPath,
        ['--input-type=module', '-e', `${source}\nprocess.exit(0)`],
        {
          env: {
            ...process.env,
            NODE_OPTIONS: `--import ${import.meta.url}`,
            PROMPTFIXER_NETWATCH_LOG: log,
            ...blankedProxyEnv(),
            ...env,
          },
          stdio: 'ignore',
        }
      )
      // A probe that wedges must fail its own test, not hang the suite.
      const cut = setTimeout(() => child.kill('SIGKILL'), 10_000)
      const done = () => {
        clearTimeout(cut)
        resolve()
      }
      child.on('exit', done)
      child.on('error', done)
    })
    return readAttempts(log)
  } finally {
    fs.rmSync(log, { force: true })
  }
}

/** Read what a watched process recorded. Used by the test, not by the watcher. */
export function readAttempts(logPath) {
  let text = ''
  try {
    text = fs.readFileSync(logPath, 'utf8')
  } catch {
    // Never written to means nothing was ever attempted, which is the pass case.
    return []
  }
  return parseNdjson(text)
}
