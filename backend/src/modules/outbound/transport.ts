import { Agent, ProxyAgent, type Dispatcher, type buildConnector } from 'undici'
import { connect as tlsConnect } from 'node:tls'
import type { LookupFunction } from 'node:net'
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
  }).catch(() => callback(new OutboundError('policy'), '', 4))
}

/** Called with an already validated/pinned proxy IP; never a credential-bearing URL. */
export function proxyDispatcher(profile: ProxyProfile, address: string): Dispatcher {
  if (profile.type !== 'socks5') {
    const host = address.includes(':') ? `[${address}]` : address
    return new ProxyAgent({ uri: `${profile.type}://${host}:${profile.port}`, connections: 4, pipelining: 1,
      token: profile.username ? `Basic ${Buffer.from(`${profile.username}:${profile.password}`).toString('base64')}` : undefined,
      proxyTls: { servername: profile.host, rejectUnauthorized: true, timeout: profile.timeoutMs },
      requestTls: { rejectUnauthorized: true, timeout: profile.timeoutMs },
      headersTimeout: profile.timeoutMs, bodyTimeout: profile.timeoutMs,
    })
  }
  const connector: buildConnector.connector = (options, callback) => {
    // Destination remains a hostname (SOCKS5 ATYP=3): DNS is resolved by the proxy.
    void SocksClient.createConnection({ command: 'connect',
      proxy: { host: address, port: profile.port, type: 5, userId: profile.username || undefined, password: profile.password || undefined },
      destination: { host: options.hostname, port: Number(options.port || 443) }, timeout: profile.timeoutMs,
    }).then(({ socket }) => {
      let completed = false
      const secure = tlsConnect({ socket, servername: options.hostname, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] })
      const finish = (error?: Error) => {
        if (completed) return
        completed = true; clearTimeout(timer)
        if (error) { secure.destroy(); callback(error, null) } else callback(null, secure)
      }
      const timer = setTimeout(() => finish(new OutboundError('timeout')), profile.timeoutMs)
      secure.once('secureConnect', () => finish())
      secure.once('error', error => finish(error))
    }).catch(error => callback(new OutboundError(errorCategory(error)), null))
  }
  return new Agent({ connect: connector, connections: 4, pipelining: 1, headersTimeout: profile.timeoutMs, bodyTimeout: profile.timeoutMs })
}
export function directDispatcher(): Dispatcher {
  return new Agent({ connect: { lookup: publicLookup, rejectUnauthorized: true, timeout: 10000 }, connections: 4, pipelining: 1 })
}
