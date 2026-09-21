/**
 * Regression guards for acceptance/support/netwatch.mjs — the watcher that
 * backs scenario F11, "Nothing leaves the machine".
 *
 * Every case here is a way code reached the network past an earlier version of
 * that watcher. A watcher with a hole in it makes F11 worse than useless: it
 * turns "we did not observe egress" into "there is no egress", which is exactly
 * the claim nobody should make on bad evidence. So each hole gets a test.
 *
 * Every destination is under .invalid (RFC 6761), which never resolves, so the
 * attempt is recorded and no packet reaches the wire. Run with: npm test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isLocal, isLocalPath, runWatched } from '../acceptance/support/netwatch.mjs'

const watched = runWatched

const hosts = (attempts) => attempts.map((a) => a.host)
/**
 * Assert a specific hook fired, not merely that the host appears somewhere.
 * Nearly every case below also trips the DNS hook on its way out, so asserting
 * on the host alone would pass even with the hook under test removed.
 */
const sawVia = (attempts, kind, host) =>
  attempts.some((a) => a.kind === kind && a.host === host)
const swallow = "on('error', () => {})"

// --- what counts as this machine ---------------------------------------------

test('loopback in all its spellings is this machine', () => {
  for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '']) {
    assert.equal(isLocal(host), true, host || '(empty)')
  }
})

test('anything else is not', () => {
  for (const host of ['example.invalid', '10.0.0.5', '8.8.8.8', '::2', 'evil.localhost.example.com']) {
    assert.equal(isLocal(host), false, host)
  }
})

test('a named pipe is this machine but a UNC share is another one', () => {
  assert.equal(isLocalPath('\\\\.\\pipe\\promptfixer'), true)
  assert.equal(isLocalPath('\\\\?\\C:\\x'), true)
  assert.equal(isLocalPath('/tmp/app.sock'), true)
  // \\server\share carries bytes to another host over SMB.
  assert.equal(isLocalPath('\\\\fileserver\\share\\dump.bin'), false)
})

// --- the ordinary paths -------------------------------------------------------

test('fetch to a hostname is recorded with the hostname, before DNS', async () => {
  const seen = await watched("await fetch('https://plain-fetch.example.invalid/x').catch(() => {})")
  assert.ok(hosts(seen).includes('plain-fetch.example.invalid'), JSON.stringify(seen))
  assert.ok(seen.some((a) => a.kind === 'tcp'), 'the socket layer saw it, not only DNS')
})

test('https and http agents are recorded', async () => {
  const seen = await watched(
    `import https from 'node:https'\nhttps.request('https://agent.example.invalid/x').${swallow}.end()\nawait new Promise((r) => setTimeout(r, 150))`
  )
  assert.ok(sawVia(seen, 'tcp', 'agent.example.invalid'), JSON.stringify(seen))
})

// --- the holes that were found ------------------------------------------------

test('a string port does not slip past the TCP hook', async () => {
  // url.port is always a string, so this is an ordinary shape, not an exotic
  // one. An earlier version guarded on `typeof first === 'number'` and recorded
  // nothing at all for this.
  const seen = await watched(
    `import net from 'node:net'\nnew net.Socket().connect('443', 'string-port.example.invalid').${swallow}\nawait new Promise((r) => setTimeout(r, 150))`
  )
  // Specifically the TCP hook: the DNS hook records this host on the way out
  // too, so asserting on the host alone passes even with the TCP hook blind.
  assert.ok(sawVia(seen, 'tcp', 'string-port.example.invalid'), JSON.stringify(seen))
})

test('an ESM named import of dns is still hooked', async () => {
  // A builtin's ESM facade freezes its named exports when first instantiated.
  // Patching the namespace object from an ESM preload left this unhooked.
  const seen = await watched(
    `import { lookup } from 'node:dns'\nlookup('named-import.example.invalid', () => {})\nawait new Promise((r) => setTimeout(r, 150))`
  )
  assert.ok(sawVia(seen, 'dns', 'named-import.example.invalid'), JSON.stringify(seen))
})

test('dns.resolve4, which never touches a socket in JavaScript, is recorded', async () => {
  const seen = await watched(
    `import dns from 'node:dns'\ndns.resolve4('c-ares.example.invalid', () => {})\nawait new Promise((r) => setTimeout(r, 200))`
  )
  assert.ok(sawVia(seen, 'dns', 'c-ares.example.invalid'), JSON.stringify(seen))
})

test('a Resolver instance is hooked, not just the module functions', async () => {
  const seen = await watched(
    `import dns from 'node:dns'\nnew dns.Resolver().resolve4('resolver-instance.example.invalid', () => {})\nawait new Promise((r) => setTimeout(r, 200))`
  )
  assert.ok(sawVia(seen, 'dns', 'resolver-instance.example.invalid'), JSON.stringify(seen))
})

test('a connected UDP socket, whose send names no address, is recorded', async () => {
  const seen = await watched(
    `import dgram from 'node:dgram'\nconst s = dgram.createSocket('udp4')\ns.${swallow}\ns.connect(53, 'udp-connected.example.invalid')\nawait new Promise((r) => setTimeout(r, 250))`
  )
  assert.ok(sawVia(seen, 'udp', 'udp-connected.example.invalid'), JSON.stringify(seen))
})

test('a TLS tunnel that names its destination only as servername is recorded', async () => {
  // How an HTTPS-over-proxy CONNECT works: the socket is already open to the
  // proxy, so the real destination exists nowhere but here.
  const seen = await watched(
    [
      "import net from 'node:net'",
      "import tls from 'node:tls'",
      "const socket = new net.Socket()",
      `socket.${swallow}`,
      "tls.connect({ socket, servername: 'tunnelled.example.invalid' })" + `.${swallow}`,
      'await new Promise((r) => setTimeout(r, 200))',
    ].join('\n')
  )
  assert.ok(sawVia(seen, 'tls', 'tunnelled.example.invalid'), JSON.stringify(seen))
})

test('execSync is recorded, though it never calls the spawnSync export', async () => {
  const seen = await watched(
    `import { execSync } from 'node:child_process'\ntry { execSync('${process.platform === 'win32' ? 'cmd /c echo hi' : 'echo hi'}') } catch {}`
  )
  assert.ok(
    seen.some((a) => a.kind === 'spawn'),
    `a sync shell-out must be visible, or its traffic is invisible twice over: ${JSON.stringify(seen)}`
  )
})

test('a worker that clears execArgv is still watched', async () => {
  // `node --import` on the command line does not survive execArgv: []; the
  // NODE_OPTIONS install does, which is why the harness uses it.
  const seen = await watched(
    [
      "import { Worker } from 'node:worker_threads'",
      "const code = \"import net from 'node:net'; net.connect(443, 'worker-escape.example.invalid').on('error', () => {})\"",
      "const w = new Worker(code, { eval: true, execArgv: [] })",
      "w.on('error', () => {})",
      'await new Promise((r) => setTimeout(r, 700))',
      'await w.terminate()',
    ].join('\n')
  )
  assert.ok(sawVia(seen, 'tcp', 'worker-escape.example.invalid'), JSON.stringify(seen))
})

test('a node child process inherits the watcher', async () => {
  const seen = await watched(
    [
      "import { spawn } from 'node:child_process'",
      "const src = \"import net from 'node:net'; net.connect(443, 'child-escape.example.invalid').on('error', () => {})\"",
      "const c = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: 'ignore' })",
      'await new Promise((r) => c.on(\'exit\', r))',
      'await new Promise((r) => setTimeout(r, 200))',
    ].join('\n')
  )
  assert.ok(sawVia(seen, 'tcp', 'child-escape.example.invalid'), JSON.stringify(seen))
})

test('a UNC path is not waved through as a local pipe', async () => {
  const seen = await watched(
    `import net from 'node:net'\nnet.connect({ path: '\\\\\\\\fileserver\\\\share\\\\x' }).${swallow}\nawait new Promise((r) => setTimeout(r, 150))`
  )
  assert.ok(
    seen.some((a) => a.kind === 'unc'),
    `writing to another host's share is egress without a socket to it: ${JSON.stringify(seen)}`
  )
})

test('a proxy variable is reported, because it makes real egress look local', async () => {
  const seen = await watched('await new Promise((r) => setTimeout(r, 50))', {
    env: { HTTPS_PROXY: 'http://127.0.0.1:8080' },
  })
  assert.ok(
    seen.some((a) => a.kind === 'proxy'),
    `a proxy on loopback would make every destination look like this machine: ${JSON.stringify(seen)}`
  )
})

// --- and the quiet case -------------------------------------------------------

test('a process that talks only to this machine records nothing', async () => {
  const seen = await watched(
    [
      "import net from 'node:net'",
      "import dns from 'node:dns'",
      "const server = net.createServer(() => {}).listen(0, '127.0.0.1')",
      "await new Promise((r) => server.on('listening', r))",
      "const c = net.connect(server.address().port, '127.0.0.1')",
      `c.${swallow}`,
      "dns.lookup('localhost', () => {})",
      'await new Promise((r) => setTimeout(r, 200))',
      'c.destroy(); server.close()',
    ].join('\n')
  )
  assert.deepEqual(seen, [], 'loopback is not leaving the machine')
})
