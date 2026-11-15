import WebSocket from 'ws'
import type { NetworkCategory } from '../../contracts/outbound.js'
import { openHetznerConsole } from '../outbound/client.js'
import { errorCategory } from '../outbound/policy.js'

export async function connectConsole(url: string, cancel: AbortSignal) {
  const route = await openHetznerConsole(url, cancel)
  if (route.signal.aborted) {
    route.socket.destroy()
    if (!cancel.aborted) route.record('timeout', Date.now() - route.started)
    route.signal.throwIfAborted()
  }
  const socket = new WebSocket(route.url, { createConnection: () => route.socket, followRedirects: false,
    perMessageDeflate: false, maxPayload: 2 * 1024 * 1024 })
  const abort = () => socket.terminate()
  let latency: number | undefined
  let failed = false
  const fail = (code: NetworkCategory) => {
    if (failed || cancel.aborted) return
    failed = true
    route.record(route.signal.aborted && latency === undefined ? 'timeout' : code, latency ?? Date.now() - route.started)
  }
  route.signal.addEventListener('abort', abort, { once: true })
  socket.once('open', () => {
    route.signal.removeEventListener('abort', abort)
    latency = Date.now() - route.started
    route.record('none', latency)
  })
  socket.on('error', error => fail(errorCategory(error)))
  socket.once('close', code => {
    route.signal.removeEventListener('abort', abort)
    if (code !== 1000 && code !== 1001) fail('upstream')
  })
  return { socket, isCurrent: route.isCurrent }
}
