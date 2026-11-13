import type { Server } from './types'
export const isProvisioning = (server: Server) => !!server.tracking && ['queued', 'provisioning', 'requires_review', 'outcome_unknown'].includes(server.tracking.state)
export const serverRowKey = (server: Server) => server.tracking ? `${server.tracking.source}:${server.tracking.reference}` : server.id
export const lifecycleLabels = {
  queued: 'در صف ساخت', provisioning: 'در حال ساخت سرور…', ready: 'آماده / تأییدشده', failed: 'خطای ساخت',
  requires_review: 'نیازمند بررسی', outcome_unknown: 'نتیجه نامشخص', cancelled: 'لغو شده',
  deletion_requested: 'درخواست حذف ثبت شد', deleting: 'در حال حذف', terminated: 'حذف تأیید شد', delete_failed: 'حذف ناموفق',
}

/** IndexedDB transactions serialize notification claims across tabs. No secrets. */
export async function claimLifecycleNotice(userId: string, server: Server, shouldClaim: () => boolean = () => true): Promise<boolean> {
  if (!server.tracking || !userId || typeof indexedDB === 'undefined') return false
  const key = `${userId}:${serverRowKey(server)}`
  const terminal = ['ready', 'failed', 'cancelled'].includes(server.tracking.state)
  return new Promise<boolean>(resolve => {
    const request = indexedDB.open('parserver-lifecycle', 1)
    request.onupgradeneeded = () => { request.result.createObjectStore('notices') }
    request.onerror = () => resolve(false)
    request.onblocked = () => resolve(false)
    request.onsuccess = () => {
      const db = request.result
      let notify = false
      const tx = db.transaction('notices', 'readwrite'), store = tx.objectStore('notices'), read = store.get(key)
      read.onsuccess = () => {
        if (!shouldClaim()) return
        const prior = read.result as { pending?: boolean; terminal?: string } | undefined
        if (terminal) {
          if (prior?.pending && !prior.terminal) { notify = true; store.put({ pending: true, terminal: server.tracking!.state }, key) }
          else if (!prior) store.put({ pending: false, terminal: server.tracking!.state }, key)
        } else if (!prior?.terminal) store.put({ pending: true }, key)
      }
      tx.oncomplete = () => { db.close(); resolve(notify) }
      tx.onerror = tx.onabort = () => { db.close(); resolve(false) }
    }
  }).catch(() => false)
}

const accepted = new Map<string, Map<string, Server>>()
export function acceptedServers(userId: string): Server[] { return [...(accepted.get(userId)?.values() ?? [])] }
export function forgetAcceptedServer(userId: string, server: Server) { accepted.get(userId)?.delete(serverRowKey(server)) }
export function rememberAcceptedServer(userId: string, server: Server) {
  if (!accepted.has(userId)) accepted.set(userId, new Map())
  accepted.get(userId)!.set(serverRowKey(server), server)
  window.dispatchEvent(new Event('server-order-accepted'))
}
