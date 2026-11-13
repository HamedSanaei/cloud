import WebSocket from 'ws'
export function connectConsole(url: string): WebSocket {
  return new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: 10000, maxPayload: 2 * 1024 * 1024 })
}
