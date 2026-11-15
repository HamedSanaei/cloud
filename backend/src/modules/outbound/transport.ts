import { Agent, type Dispatcher, type buildConnector } from 'undici'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import { connect, isIP, type LookupFunction, type Socket } from 'node:net'
import { SocksClient } from 'socks'
import type { ProxyProfile } from '../../contracts/outbound.js'
import { errorCategory, OutboundError, publicAddresses } from './policy.js'

const publicLookup: LookupFunction = (host, options, callback) => {
  void publicAddresses(host).then(rows => {
    const wanted = typeof options === 'object' ? options.family : undefined
    const row = rows.find(row => !wanted || row.family === wanted)
    if (!row) throw new OutboundError('policy')
    if (options.all) callback(null, rows)
    else callback(null, row.address, row.family)
  }).catch(error => callback(new OutboundError(errorCategory(error)), '', 4))
}

type ProxyHop = { profile: ProxyProfile; address: string }

async function socksTunnel(host: string, { profile, address }: ProxyHop, signal: AbortSignal) {
  const socket = connect({ host: address, port: profile.port })
  const cancel = () => socket.destroy()
  signal.addEventListener('abort', cancel, { once: true })
  try {
    await once(socket, 'connect', { signal })
    // The destination hostname is sent to the proxy for remote DNS resolution.
    await SocksClient.createConnection({ command: 'connect', existing_socket: socket,
      proxy: { host: address, port: profile.port, type: 5, userId: profile.username || undefined, password: profile.password || undefined },
      destination: { host, port: 443 }, timeout: profile.timeoutMs })
    signal.throwIfAborted()
    return socket
  } catch (error) {
    socket.destroy()
    if (signal.aborted) throw new OutboundError('timeout')
    throw error
  } finally { signal.removeEventListener('abort', cancel) }
}

function httpTunnel(host: string, { profile, address }: ProxyHop, signal: AbortSignal) {
  return new Promise<Socket>((resolve, reject) => {
    const authority = `${host}:443`
    const request = profile.type === 'https' ? httpsRequest : httpRequest
    const req = request({ host: address, port: profile.port, method: 'CONNECT', path: authority, agent: false, signal,
      servername: isIP(profile.host) ? '' : profile.host, rejectUnauthorized: true,
      headers: { Host: authority,
        ...(profile.username ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${profile.username}:${profile.password}`).toString('base64')}` } : {}) },
    })
    req.once('error', reject)
    req.once('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        reject(new OutboundError(res.statusCode === 407 ? 'authentication' : 'unreachable'))
        return
      }
      if (head.length) socket.unshift(head)
      resolve(socket)
    })
    req.end()
  })
}

/** Callers validate the destination hostname and pin the proxy address before opening a tunnel. */
export async function connectTargetTls(host: string, signal: AbortSignal, via?: ProxyHop) {
  signal.throwIfAborted()
  const tunnel = via && await (via.profile.type === 'socks5' ? socksTunnel(host, via, signal) : httpTunnel(host, via, signal))
  const secure = tlsConnect({ ...(tunnel ? { socket: tunnel } : { host, port: 443, lookup: publicLookup }),
    servername: host, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] })
  try {
    await once(secure, 'secureConnect', { signal })
    return secure
  } catch (error) {
    secure.destroy()
    throw error
  }
}

export function proxyDispatcher(profile: ProxyProfile, address: string): Dispatcher {
  const connector: buildConnector.connector = (options, callback) => {
    void connectTargetTls(options.hostname, AbortSignal.timeout(profile.timeoutMs), { profile, address })
      .then(socket => callback(null, socket), error => callback(new OutboundError(errorCategory(error)), null))
  }
  return new Agent({ connect: connector, connections: 4, pipelining: 1, headersTimeout: profile.timeoutMs, bodyTimeout: profile.timeoutMs })
}
export function directDispatcher(): Dispatcher {
  return new Agent({ connect: { lookup: publicLookup, rejectUnauthorized: true, timeout: 10000 }, connections: 4, pipelining: 1 })
}
