/** Real loopback CONNECT/SOCKS handshakes and TLS. No production API is contacted. */
import { createServer as httpServer } from 'node:http'
import { createServer as httpsServer } from 'node:https'
import { createServer as tcpServer, connect, type Server, type Socket } from 'node:net'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import * as policy from '../../src/modules/outbound/policy.js'
import { OutboundHttp, installOutboundClient, integrationFetcher } from '../../src/modules/outbound/client.js'
import { HetznerClient } from '../../src/modules/providers/hetzner/client.js'
import { createCustomerProvider } from '../../src/modules/providers/hetzner/customer.js'
import { connectConsole } from '../../src/modules/servers/console-transport.js'
import { LeasewebClient } from '../../src/modules/providers/leaseweb/client.js'
import { ProviderUnknownError } from '../../src/lib/errors.js'
import { pino } from 'pino'
import type { OutboundState, ProxyType, OutboundIntegration } from '../../src/contracts/outbound.js'

const sockets = new Set<Socket>(), servers: Server[] = []
const roots = getCACertificates('default')
let directory: string, certificate: string, upstreamPort: number
let mode: 'ok' | 'drop' | 'redirect' | 'stall', mutations: number, authenticated: boolean, rejectAuth: boolean, upgrades: number
let ports: Record<ProxyType, number>, hosts: string[], proxyHeaders: Record<string, unknown>[], cleanups: Array<() => Promise<void>>
const track = (socket: Socket) => { sockets.add(socket); socket.on('error', () => undefined); socket.once('close', () => sockets.delete(socket)); return socket }
const listen = (server: Server) => new Promise<number>(resolve => {
  servers.push(server); server.on('connection', track)
  server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
})
const tunnel = (incoming: Socket, reply: () => void) => {
  const destination = track(connect(upstreamPort, '127.0.0.1', () => { reply(); incoming.pipe(destination); destination.pipe(incoming) }))
  incoming.on('close', () => destination.destroy())
  destination.on('error', () => incoming.destroy())
}

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'parserver-outbound-'))
  const keyPath = path.join(directory, 'key.pem'), certPath = path.join(directory, 'cert.pem')
  const openssl = process.platform === 'win32' && existsSync('C:/Program Files/Git/usr/bin/openssl.exe') ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl'
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '2',
    '-subj', '/CN=proxy.fixture.test', '-addext', 'subjectAltName=DNS:proxy.fixture.test,DNS:api.hetzner.cloud,DNS:api.leaseweb.com,DNS:web-console.hetzner.cloud'], { stdio: 'ignore' })
  certificate = readFileSync(certPath, 'utf8')
  const tls = { key: readFileSync(keyPath), cert: certificate }
  const upstream = httpsServer(tls, async (request, response) => {
    for await (const _chunk of request) { /* Consume a potentially accepted mutation. */ }
    if (request.method === 'POST') mutations++
    if (mode === 'drop') { request.socket.destroy(); return }
    if (mode === 'redirect') { response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }); response.end(); return }
    expect(request.headers['proxy-authorization']).toBeUndefined()
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(request.url?.endsWith('/request_console') ?
      { wss_url: 'wss://web-console.hetzner.cloud/?token=fixture-ticket', password: 'fixture-vnc' } :
      { locations: [{ id: 1 }], accepted: true }))
  })
  const consoleServer = new WebSocketServer({ noServer: true })
  upstream.on('upgrade', (request, socket, head) => {
    upgrades++
    if (mode === 'redirect') { socket.end('HTTP/1.1 302 Found\r\nLocation: wss://localhost/\r\nContent-Length: 0\r\n\r\n'); return }
    expect(request.headers.authorization).toBeUndefined()
    expect(request.headers['proxy-authorization']).toBeUndefined()
    consoleServer.handleUpgrade(request, socket, head, ws => {
      ws.on('error', () => undefined)
      ws.on('message', (data, binary) => ws.send(data, { binary }))
    })
  })
  upstreamPort = await listen(upstream)
  const proxies = [httpServer(), httpsServer(tls)]
  const connectPorts: number[] = []
  for (const proxy of proxies) {
    proxy.on('connect', (request, socket) => {
      proxyHeaders.push(request.headers); hosts.push(request.url!)
      authenticated = request.headers['proxy-authorization'] === `Basic ${Buffer.from('fixture-user:fixture-password').toString('base64')}`
      if (rejectAuth || !authenticated) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n'); return }
      if (mode === 'stall') return
      tunnel(socket as Socket, () => socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'))
    })
    connectPorts.push(await listen(proxy))
  }
  const socks = tcpServer(socket => {
    let data = Buffer.alloc(0), stage = 'greeting'
    const read = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk])
      while (true) {
        if (stage === 'greeting') {
          if (data.length < 2 || data.length < 2 + data[1]!) return
          data = data.subarray(2 + data[1]!); socket.write(Buffer.from([5, 2])); stage = 'auth'
        } else if (stage === 'auth') {
          if (data.length < 2 || data.length < 3 + data[1]!) return
          const userLength = data[1]!, passwordLength = data[2 + userLength]!, end = 3 + userLength + passwordLength
          if (data.length < end) return
          authenticated = data.subarray(2, 2 + userLength).toString() === 'fixture-user' && data.subarray(3 + userLength, end).toString() === 'fixture-password'
          data = data.subarray(end)
          if (rejectAuth || !authenticated) { socket.end(Buffer.from([1, 1])); return }
          socket.write(Buffer.from([1, 0])); stage = 'connect'
        } else {
          if (data.length < 5) return
          // socks5h must send a hostname, not a locally resolved target address.
          expect(data[3]).toBe(3)
          const length = data[4]!, end = 7 + length
          if (data.length < end) return
          hosts.push(`${data.subarray(5, 5 + length)}:${data.readUInt16BE(5 + length)}`)
          data = data.subarray(end); socket.removeListener('data', read)
          if (mode === 'stall') return
          tunnel(socket, () => socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])))
          return
        }
      }
    }
    socket.on('data', read)
  })
  ports = { http: connectPorts[0]!, https: connectPorts[1]!, socks5: await listen(socks) }
})
beforeEach(() => {
  setDefaultCACertificates([...roots, certificate])
  mode = 'ok'; mutations = 0; upgrades = 0; authenticated = false; rejectAuth = false; hosts = []; proxyHeaders = []; cleanups = []
  vi.spyOn(policy, 'publicAddresses').mockImplementation(async host => {
    expect(host).toBe('proxy.fixture.test')
    return [{ address: '127.0.0.1', family: 4 }] // Test fixture only; production rejects loopback.
  })
})
afterEach(async () => { await Promise.all(cleanups.map(close => close())); setDefaultCACertificates(roots); vi.restoreAllMocks() })
afterAll(async () => {
  for (const socket of sockets) socket.destroy()
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  if (path.dirname(directory) !== tmpdir() || !path.basename(directory).startsWith('parserver-outbound-')) throw new Error('Unexpected fixture cleanup path')
  rmSync(directory, { recursive: true, force: true }) // Exact mkdtemp-created fixture directory only.
})
function configure(type: ProxyType, integration: OutboundIntegration = 'hetzner', edit?: (state: OutboundState) => void) {
  const id = randomUUID()
  const state: OutboundState = { revision: randomUUID(), profiles: [{ id, name: 'Fixture', type, host: 'proxy.fixture.test', port: ports[type], timeoutMs: 2000, enabled: true, username: 'fixture-user', password: 'fixture-password' }],
    routes: { [integration]: { enabled: true, profileId: id, failurePolicy: 'closed' } } }
  edit?.(state)
  const client = new OutboundHttp(async () => structuredClone(state))
  cleanups.push(installOutboundClient(client))
  return client
}

describe.each(['http', 'https', 'socks5'] as const)('%s actual outbound transport', type => {
  it('uses one proxy policy for the console grant, WSS handshake and bidirectional frames', async () => {
    let state!: OutboundState
    configure(type, 'hetzner', value => { state = value })
    const client = new HetznerClient('https://api.hetzner.cloud/v1', 'fixture-provider-token', integrationFetcher('hetzner'))
    const provider = createCustomerProvider(() => ({ id: '1', client }), async () => { throw new Error('unexpected inspection') })
    const grant = await provider.console('fixture:1')
    const cancel = new AbortController()
    const connection = await connectConsole(grant.url, cancel.signal)
    const ws = connection.socket
    cleanups.push(async () => { cancel.abort(); if (ws.readyState < 2) { const closed = once(ws, 'close'); ws.close(1000); await closed } })
    await once(ws, 'open')
    for (const frame of [Buffer.from([0, 255, 42]), 'fixture-text']) {
      const echo = once(ws, 'message')
      ws.send(frame)
      expect(await echo).toEqual([Buffer.from(frame), Buffer.isBuffer(frame)])
    }
    expect(hosts).toEqual(['api.hetzner.cloud:443', 'web-console.hetzner.cloud:443'])
    expect(upgrades).toBe(1)
    expect(JSON.stringify(proxyHeaders)).not.toMatch(/fixture-provider-token|fixture-ticket/)
    expect(await connection.isCurrent()).toBe(true)
    state.routes.hetzner!.enabled = false; state.revision = randomUUID()
    expect(await connection.isCurrent()).toBe(false)
  })
  it('fails a console handshake with bad proxy credentials without a direct connection', async () => {
    rejectAuth = true
    configure(type)
    await expect(connectConsole('wss://web-console.hetzner.cloud/?token=fixture-ticket', new AbortController().signal))
      .rejects.toMatchObject({ category: 'authentication' })
    expect(upgrades).toBe(0)
  })
  it('bounds stalled console proxy handshakes', async () => {
    mode = 'stall'
    configure(type, 'hetzner', state => { state.profiles[0]!.timeoutMs = 200 })
    await expect(connectConsole('wss://web-console.hetzner.cloud/', new AbortController().signal)).rejects.toMatchObject({ category: 'timeout' })
    expect(upgrades).toBe(0)
  })
  it('routes an actual Hetzner client through an authenticated proxy with verified upstream TLS', async () => {
    configure(type)
    const client = new HetznerClient('https://api.hetzner.cloud/v1', 'fixture-provider-token', integrationFetcher('hetzner'))
    expect(await client.request('GET', '/locations')).toEqual({ locations: [{ id: 1 }], accepted: true })
    expect(authenticated).toBe(true)
    expect(hosts).toEqual(['api.hetzner.cloud:443'])
    expect(JSON.stringify(proxyHeaders)).not.toContain('fixture-provider-token')
    expect(vi.mocked(policy.publicAddresses).mock.calls.every(([host]) => host === 'proxy.fixture.test')).toBe(true)
  })
  it('keeps TLS verification enabled and refuses untrusted certificates', async () => {
    setDefaultCACertificates(roots)
    const client = configure(type)
    await expect(client.request('hetzner', 'https://api.hetzner.cloud/v1/locations')).rejects.toBeInstanceOf(policy.OutboundError)
  })
  it('does not bypass proxy authentication failure', async () => {
    rejectAuth = true
    const client = configure(type)
    await expect(client.request('hetzner', 'https://api.hetzner.cloud/v1/locations')).rejects.toMatchObject({ category: 'authentication' })
    expect(mutations).toBe(0)
  })
  it('verifies the upstream hostname even when the issuing certificate is trusted', async () => {
    const client = configure(type, 'tabapay')
    await expect(client.request('tabapay', policy.testTargets.tabapay.url)).rejects.toMatchObject({ category: 'tls' })
    expect(mutations).toBe(0)
  })
  it('does not follow a redirect to metadata or repeat an ambiguously accepted Hetzner mutation', async () => {
    const client = configure(type)
    mode = 'redirect'
    await expect(client.request('hetzner', 'https://api.hetzner.cloud/v1/locations')).rejects.toBeInstanceOf(policy.OutboundError)
    expect(hosts.every(host => host === 'api.hetzner.cloud:443')).toBe(true)
    mode = 'drop'
    const provider = new HetznerClient('https://api.hetzner.cloud/v1', 'fixture-token', integrationFetcher('hetzner'))
    await expect(provider.request('POST', '/servers', { name: 'fixture-only' })).rejects.toBeInstanceOf(ProviderUnknownError)
    expect(mutations).toBe(1)
  })
  it('preserves Leaseweb unknown outcomes without resending accepted mutations', async () => {
    configure(type, 'leaseweb'); mode = 'drop'
    const provider = new LeasewebClient({ baseUrl: 'https://api.leaseweb.com', apiKey: 'fixture-token', logger: pino({ level: 'silent' }) })
    expect((await provider.postMutating('/publicCloud/v1/instances', {})).kind).toBe('unknown')
    expect(mutations).toBe(1)
  })
})

it('rejects upstream console redirects and blocks an unapproved destination before dialing the proxy', async () => {
  configure('http')
  const cancel = new AbortController()
  await expect(connectConsole('wss://another.hetzner.cloud/', cancel.signal)).rejects.toMatchObject({ category: 'policy' })
  expect(hosts).toEqual([])
  mode = 'redirect'
  const { socket } = await connectConsole('wss://web-console.hetzner.cloud/', cancel.signal)
  await expect(once(socket, 'open')).rejects.toThrow(/302/)
  expect(hosts).toEqual(['web-console.hetzner.cloud:443'])
})

it('rejects oversized console frames through the proxy', async () => {
  configure('http')
  const { socket } = await connectConsole('wss://web-console.hetzner.cloud/', new AbortController().signal)
  await once(socket, 'open')
  const failed = once(socket, 'error')
  socket.send(Buffer.alloc(2 * 1024 * 1024 + 1))
  expect((await failed)[0]).toMatchObject({ code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' })
})

it('fails closed on proxy DNS errors and uses the allowlisted direct destination only after an explicit disable', async () => {
  let state!: OutboundState
  configure('http', 'hetzner', value => { state = value })
  vi.mocked(policy.publicAddresses).mockRejectedValue(Object.assign(new Error('fixture DNS'), { code: 'ENOTFOUND' }))
  const cancel = new AbortController()
  await expect(connectConsole('wss://web-console.hetzner.cloud/', cancel.signal)).rejects.toMatchObject({ category: 'dns', route: { route: 'proxy' } })
  expect(policy.publicAddresses).toHaveBeenCalledExactlyOnceWith('proxy.fixture.test')
  state.routes.hetzner!.enabled = false; state.revision = randomUUID()
  await expect(connectConsole('wss://web-console.hetzner.cloud/', cancel.signal)).rejects.toMatchObject({ route: { route: 'direct' } })
  expect(policy.publicAddresses).toHaveBeenLastCalledWith('web-console.hetzner.cloud')
  expect(hosts).toEqual([])
})
