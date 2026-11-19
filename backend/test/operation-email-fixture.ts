import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { DbClient } from '../src/db/index.js'
import { authChallenges, users } from '../src/db/schema.js'
import type { OperationIntent } from '../src/modules/auth/operation-email.js'

export async function operationEmailHeaders(app: FastifyInstance, db: DbClient, userId: string, headers: Record<string, string>, intent: OperationIntent) {
  await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, userId))
  // Let independent lifecycle scenarios reuse the account without waiting for the SMTP cooldown.
  await db.update(authChallenges).set({ resendAfter: new Date(0) }).where(and(eq(authChallenges.userId, userId), eq(authChallenges.kind, 'server_operation_email')))
  const address = userId.replaceAll('-', '').match(/.{4}/g)!.join(':')
  const response = await app.inject({ method: 'POST', url: '/api/auth/operation-email/start', headers, payload: intent, remoteAddress: address })
  if (response.statusCode !== 202) throw new Error(`Could not issue fixture email challenge (${response.statusCode}): ${response.body}`)
  const { data } = response.json<{ data: { token: string; developmentCode: string } }>()
  return { ...headers, 'idempotency-key': intent.key, 'x-operation-token': data.token, 'x-operation-code': data.developmentCode }
}
