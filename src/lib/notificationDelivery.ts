import type { AppNotification } from './types'

const memory = new Set<string>()

/** A read-write transaction prevents two tabs from showing the same toast. */
export async function claimNotificationToasts(userId: string, items: AppNotification[], active: () => boolean) {
  const unread = items.filter(item => !item.read)
  if (!unread.length) return []
  const key = (item: AppNotification) => `notification:${userId}:${item.id}`
  const claimed = await new Promise<AppNotification[] | null>(resolve => {
    const request = indexedDB.open('parserver-lifecycle', 1)
    request.onupgradeneeded = () => { request.result.createObjectStore('notices') }
    request.onerror = request.onblocked = () => resolve(null)
    request.onsuccess = () => {
      const db = request.result
      const fresh: AppNotification[] = []
      const tx = db.transaction('notices', 'readwrite'), store = tx.objectStore('notices')
      for (const item of unread) {
        const previous = store.get(key(item))
        previous.onsuccess = () => {
          if (!active() || previous.result) return
          fresh.push(item)
          store.put(true, key(item))
        }
      }
      tx.oncomplete = () => { db.close(); resolve(fresh) }
      tx.onerror = tx.onabort = () => { db.close(); resolve(null) }
    }
  }).catch(() => null)
  if (claimed) return claimed
  if (!active()) return []
  return unread.filter(item => {
    const id = key(item)
    if (memory.has(id)) return false
    memory.add(id)
    try {
      if (localStorage.getItem(id)) return false
      localStorage.setItem(id, '1')
    } catch { /* Storage may be disabled. */ }
    return true
  })
}
