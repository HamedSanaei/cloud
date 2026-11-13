import { and, eq, inArray } from 'drizzle-orm'
import { notifications, servers } from '../../db/schema.js'
import type { DbOrTx } from '../../db/index.js'

type Notice = Pick<typeof notifications.$inferInsert, 'userId' | 'title' | 'body' | 'href' | 'createdAt'> & {
  eventKey: string
  type: 'info' | 'success' | 'warning' | 'error'
}

export async function publishNotification(db: DbOrTx, notice: Notice) {
  await db.insert(notifications).values(notice).onConflictDoNothing({ target: [notifications.userId, notifications.eventKey] })
}

export async function listNotifications(db: DbOrTx, userId: string) {
  const rows = await db.query.notifications.findMany({
    where: t => eq(t.userId, userId),
    orderBy: (t, { desc }) => [desc(t.createdAt), desc(t.id)],
    limit: 50,
  })
  return rows.map(n => ({ id: n.id, title: n.title, body: n.body, type: n.type, read: n.read,
    href: n.href, createdAt: n.createdAt.toISOString() }))
}

export async function readNotifications(db: DbOrTx, userId: string, ids?: string[]) {
  await db.update(notifications).set({ read: true }).where(and(eq(notifications.userId, userId),
    ids ? inArray(notifications.id, ids) : undefined))
}

const actionLabels: Record<string, string> = {
  power_on: 'روشن‌کردن', power_off: 'خاموش‌کردن', shutdown: 'خاموش‌کردن', reboot: 'راه‌اندازی مجدد',
  reset: 'راه‌اندازی مجدد اجباری', delete: 'حذف', resize: 'تغییر پلن', rebuild: 'نصب مجدد',
  reset_password: 'بازنشانی رمز', enable_rescue: 'فعال‌سازی Rescue', disable_rescue: 'غیرفعال‌سازی Rescue',
  attach_iso: 'اتصال ISO', detach_iso: 'قطع ISO', change_protection: 'تغییر حفاظت',
}

const confirmedTitles: Record<string, string> = {
  power_on: 'سرور روشن شد', power_off: 'سرور خاموش شد', shutdown: 'سرور خاموش شد',
  reboot: 'سرور راه‌اندازی مجدد شد', reset: 'سرور راه‌اندازی مجدد شد', delete: 'سرور حذف شد',
}

export async function notifyServerOperation(db: DbOrTx, server: typeof servers.$inferSelect,
  operation: { id: string; action: string | null }, result: 'succeeded' | 'failed' | 'unknown') {
  const action = operation.action ?? ''
  const subject = `عملیات ${actionLabels[action] ?? 'مدیریت'} سرور «${server.hostname}»`
  await publishNotification(db, {
    userId: server.userId,
    eventKey: `server-operation:${operation.id}:${result}`,
    href: server.provider === 'hetzner' ? `/servers/${server.id}?tab=operations` : '/servers',
    type: result === 'succeeded' ? 'success' : result === 'failed' ? 'error' : 'warning',
    title: result === 'succeeded' ? confirmedTitles[action] ?? 'عملیات سرور تأیید شد'
      : result === 'failed' ? 'عملیات سرور ناموفق بود' : 'نتیجه عملیات سرور نامشخص است',
    body: result === 'succeeded' ? `${subject} با تأیید ارائه‌دهنده انجام شد.`
      : result === 'failed' ? `${subject} انجام نشد. جزئیات را در بخش سرورها بررسی کنید.`
        : `نتیجه ${subject} هنوز تأیید نشده است. وضعیت را دوباره بررسی کنید.`,
  })
}
