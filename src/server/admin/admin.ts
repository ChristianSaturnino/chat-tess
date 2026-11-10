import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { auditEvents, creditAccounts, users } from '@/db/schema';
import { db, withTx } from '@/db/client';
import { audit } from '../audit/audit';
import type { SessionUser } from '../auth/session';
import { AppError, forbidden, notFound } from '../errors';

export function requireAdmin(user: SessionUser) {
  if (user.role !== 'admin') throw forbidden();
}

export async function listUsersWithCredits() {
  return db()
    .select({
      id: users.id,
      kind: users.kind,
      role: users.role,
      email: users.email,
      name: users.name,
      createdAt: users.createdAt,
      limitMicro: creditAccounts.limitMicro,
      settledMicro: creditAccounts.settledMicro,
      reservedMicro: creditAccounts.reservedMicro,
    })
    .from(users)
    .leftJoin(creditAccounts, eq(creditAccounts.userId, users.id))
    .orderBy(desc(users.createdAt))
    .limit(200);
}

export async function globalAccount() {
  const [g] = await db().select().from(creditAccounts).where(eq(creditAccounts.scope, 'global'));
  return g ?? null;
}

/**
 * Ajuste de cota com auditoria na mesma transação. O limite não pode ficar abaixo do já
 * confirmado + reservado: isso descartaria consumo real em vez de bloquear o próximo.
 */
export async function setLimit(admin: SessionUser, target: { userId: string } | { global: true }, limitMicro: number, reason: string) {
  if (!Number.isSafeInteger(limitMicro) || limitMicro < 0) throw new AppError(400, 'invalid_limit', 'limite inválido');
  return withTx(async ({ db: tx }) => {
    const where = 'global' in target ? eq(creditAccounts.scope, 'global') : eq(creditAccounts.userId, target.userId);
    const [acc] = await tx.select().from(creditAccounts).where(where).for('update');
    if (!acc) throw notFound('conta de créditos');
    if (limitMicro < acc.settledMicro + acc.reservedMicro) {
      throw new AppError(409, 'limit_below_usage', 'o limite não pode ficar abaixo do consumo confirmado + reservado');
    }
    await tx.update(creditAccounts).set({ limitMicro, updatedAt: new Date() }).where(eq(creditAccounts.id, acc.id));
    await audit(tx, {
      actorUserId: admin.id,
      action: 'credits.limit_changed',
      entityType: 'credit_account',
      entityId: acc.id,
      payload: { scope: acc.scope, userId: acc.userId, from: acc.limitMicro, to: limitMicro, reason },
    });
    return { ...acc, limitMicro };
  });
}

/** Usuário vê só eventos em que é o ator; admin pode ver todos. Paginação por id decrescente. */
export async function listAudit(viewer: SessionUser, opts: { all?: boolean; before?: number; limit?: number; action?: string }) {
  if (opts.all) requireAdmin(viewer);
  const conds = [];
  if (!opts.all) conds.push(eq(auditEvents.actorUserId, viewer.id));
  if (opts.before) conds.push(lt(auditEvents.id, opts.before));
  if (opts.action) conds.push(sql`${auditEvents.action} like ${`${opts.action}%`}`);
  return db()
    .select()
    .from(auditEvents)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(auditEvents.id))
    .limit(Math.min(opts.limit ?? 50, 200));
}
