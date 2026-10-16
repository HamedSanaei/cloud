import { createHash, randomBytes } from 'node:crypto'
import argon2 from 'argon2'
import { and, eq, gte, isNull } from 'drizzle-orm'
import type { DbClient } from '../../db/index.js'
import { sessions, users } from '../../db/schema.js'
import { ConflictError, NotFoundError, UnauthorizedError } from '../../lib/errors.js'
import { writeAudit } from '../audit/service.js'

// ---------------------------------------------------------------------------
// Password hashing (Argon2id)
// ---------------------------------------------------------------------------
export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 })
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Session tokens (opaque, stored hashed)
// ---------------------------------------------------------------------------
export function generateSessionToken(): string {
  return `cls_${randomBytes(32).toString('base64url')}`
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days, sliding
const REFRESH_TTL_MS = 24 * 60 * 60 * 1000 // session usable for 24h before rotation required

export interface SessionUser {
  id: string
  email: string
  role: 'user' | 'admin'
  status: 'active' | 'pending' | 'disabled'
  sessionId: string
}

export async function createSession(
  db: DbClient,
  userId: string,
  meta: { userAgent?: string; ip?: string },
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const token = generateSessionToken()
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  const [session] = await db
    .insert(sessions)
    .values({
      userId,
      tokenHash: hashToken(token),
      userAgent: meta.userAgent ?? null,
      ip: meta.ip ?? null,
      expiresAt,
    })
    .returning({ id: sessions.id })
  if (!session) throw new Error('failed to create session')
  return { token, sessionId: session.id, expiresAt }
}

export async function registerUser(
  db: DbClient,
  input: { email: string; password: string; firstName?: string; lastName?: string; mobile?: string },
) {
  const email = input.email.trim().toLowerCase()
  const existing = await db.query.users.findFirst({ where: (t) => eq(t.email, email) })
  if (existing) throw new ConflictError('این ایمیل قبلاً ثبت شده است')

  const passwordHash = await hashPassword(input.password)
  const [user] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      mobile: input.mobile ?? null,
    })
    .returning()
  if (!user) throw new Error('failed to create user')
  return user
}

export async function login(
  db: DbClient,
  input: { email: string; password: string },
  meta: { userAgent?: string; ip?: string },
): Promise<{ user: SessionUser; token: string; sessionId: string }> {
  const user = await verifyPrimaryCredentials(db, input)
  const session = await createSession(db, user.id, meta)
  await writeAudit(db, { actorId: user.id, action: 'user.login', metadata: { ip: meta.ip } })
  return { user: toSessionUser(user, session.sessionId), token: session.token, sessionId: session.sessionId }
}

export async function verifyPrimaryCredentials(db: DbClient, input: { email: string; password: string }) {
  const email = input.email.trim().toLowerCase()
  const user = await db.query.users.findFirst({ where: (t) => eq(t.email, email) })
  // Constant-ish work even when the user does not exist (hash a dummy value).
  const ok = user ? await verifyPassword(user.passwordHash, input.password) : await verifyPassword(await hashPassword(input.password), input.password)
  if (!user || !ok || user.status !== 'active') throw new UnauthorizedError('ایمیل یا رمز عبور نادرست است')
  return user
}

export async function logout(db: DbClient, sessionId: string): Promise<void> {
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId))
}

/**
 * Resolve a session token (Bearer header or cookie value) to a user.
 * Enforces expiry and sliding renewal.
 */
export async function authenticateToken(db: DbClient, rawToken: string | undefined): Promise<SessionUser | null> {
  if (!rawToken) return null
  const tokenHash = hashToken(rawToken)
  const session = await db.query.sessions.findFirst({ where: (t) => eq(t.tokenHash, tokenHash) })
  if (!session || session.revokedAt) return null
  if (session.expiresAt < new Date()) return null

  const user = await db.query.users.findFirst({ where: (t) => eq(t.id, session.userId) })
  if (!user || user.status !== 'active') return null

  // Sliding: if the session is older than REFRESH_TTL, require a refresh call
  // (the refresh endpoint rotates the token). Touched sessions are allowed.
  const now = Date.now()
  if (now - session.lastSeenAt.getTime() > REFRESH_TTL_MS) {
    return { ...toSessionUser(user, session.id), needsRotation: true } as SessionUser & { needsRotation: boolean }
  }
  await db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, session.id))
  return toSessionUser(user, session.id)
}

/**
 * Rotate an existing session: revoke the old token, issue a new one.
 * Used by POST /auth/refresh.
 */
export async function rotateSession(
  db: DbClient,
  rawToken: string,
): Promise<{ token: string; user: SessionUser } | null> {
  const tokenHash = hashToken(rawToken)
  const session = await db.query.sessions.findFirst({ where: (t) => eq(t.tokenHash, tokenHash) })
  if (!session || session.revokedAt || session.expiresAt < new Date()) return null
  const user = await db.query.users.findFirst({ where: (t) => eq(t.id, session.userId) })
  if (!user || user.status !== 'active') return null

  const newToken = generateSessionToken()
  const newExpiry = new Date(Date.now() + SESSION_TTL_MS)
  const [created] = await db.transaction(async (tx) => {
    await tx.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, session.id))
    return tx
      .insert(sessions)
      .values({
        userId: user.id,
        tokenHash: hashToken(newToken),
        userAgent: session.userAgent,
        ip: session.ip,
        expiresAt: newExpiry,
      })
      .returning({ id: sessions.id })
  })
  await writeAudit(db, { actorId: user.id, action: 'user.session_refresh' })
  return { token: newToken, user: toSessionUser(user, created?.id ?? session.id) }
}

export async function listSessionsForUser(db: DbClient, userId: string, currentSessionId?: string) {
  const rows = await db.query.sessions.findMany({
    where: (t) => and(eq(t.userId, userId), isNull(t.revokedAt), gte(t.expiresAt, new Date())),
    orderBy: (t, { desc }) => [desc(t.lastSeenAt)],
  })
  return rows.map((s) => ({
    id: s.id,
    current: s.id === currentSessionId,
    userAgent: s.userAgent ?? 'Unknown',
    ip: s.ip ?? '',
    lastActivity: s.lastSeenAt,
    createdAt: s.createdAt,
  }))
}

export async function revokeOtherSessions(db: DbClient, userId: string, keepSessionId: string): Promise<number> {
  const all = await db.query.sessions.findMany({
    where: (t) => and(eq(t.userId, userId), isNull(t.revokedAt), gte(t.expiresAt, new Date())),
  })
  let count = 0
  for (const s of all) {
    if (s.id !== keepSessionId) {
      await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, s.id))
      count++
    }
  }
  return count
}

function toSessionUser(user: { id: string; email: string; role: 'user' | 'admin'; status: 'active' | 'pending' | 'disabled' }, sessionId: string): SessionUser {
  return { id: user.id, email: user.email, role: user.role, status: user.status, sessionId }
}

export { NotFoundError }
