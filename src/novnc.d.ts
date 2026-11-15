declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string | WebSocket, options?: { credentials?: { password?: string } })
    scaleViewport: boolean
    resizeSession: boolean
    focus(options?: FocusOptions): void
    blur(): void
    sendKey(keysym: number, code: string, down?: boolean): void
    disconnect(): void
  }
}
