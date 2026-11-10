import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { sessions, users } from '@/db/schema';
import { db, type Db } from '@/db/client';

export const SESSION_COOKIE = 'tess_session';
const SESSION_DAYS = 14;

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export type SessionUser = { id: string; kind: 'google' | 'demo'; role: 'user' | 'admin'; email: string | null; name: string | null };

/** O banco guarda só o hash do token. */
export async function createSession(d: Db, userId: string) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await d.insert(sessions).values({ userId, tokenHash: hashToken(token), expiresAt });
  return { token, expiresAt };
}

export async function userFromSessionToken(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const [row] = await db()
    .select({ id: users.id, kind: users.kind, role: users.role, email: users.email, name: users.name })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())));
  return row ?? null;
}

export async function deleteSession(token: string) {
  await db().delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}
