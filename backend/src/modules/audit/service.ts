import type { DbClient, DbOrTx } from '../../db/index.js'
import { auditLogs } from '../../db/schema.js'

export interface AuditEntry {
  actorId?: string | null
  action: string
  targetType?: string | null
  targetId?: string | null
  metadata?: Record<string, unknown> | null
  ip?: string | null
}

/** Never pass secrets or password hashes into metadata — this is append-only. */
export async function writeAudit(db: DbOrTx, entry: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({
    actorId: entry.actorId ?? null,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    metadata: entry.metadata ?? null,
    ip: entry.ip ?? null,
  })
}

export async function listAudit(db: DbClient, opts: { limit?: number; offset?: number; action?: string; actorId?: string } = {}) {
  const rows = await db.query.auditLogs.findMany({
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    limit: opts.limit ?? 50,
    offset: opts.offset ?? 0,
    where: (t, { and, eq }) =>
      and(
        opts.action ? eq(t.action, opts.action) : undefined,
        opts.actorId ? eq(t.actorId, opts.actorId) : undefined,
      ),
  })
  return rows
}