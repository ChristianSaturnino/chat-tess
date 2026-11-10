import { and, eq, gte, sql } from 'drizzle-orm';
import { users } from '@/db/schema';
import { withTx } from '@/db/client';
import { audit } from '../audit/audit';
import { config } from '../config';
import { createUserAccount } from '../credits/credits';
import { AppError } from '../errors';
import { createSession } from './session';

/** Visitante demo: usuário próprio e isolado, com cota menor e limite global de criação por hora. */
export async function createDemoUser() {
  return withTx(async ({ db: tx }) => {
    // Serializa a verificação do limite global entre requisições concorrentes.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('demo_user_creation'))`);
    const [recent] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(and(eq(users.kind, 'demo'), gte(users.createdAt, sql`now() - interval '1 hour'`)));
    if ((recent?.n ?? 0) >= config().limits.demoMaxSessionsPerHour) {
      throw new AppError(429, 'demo_capacity', 'limite de sessões demo atingido; tente mais tarde');
    }
    const [user] = await tx.insert(users).values({ kind: 'demo', name: 'Visitante demo' }).returning();
    await createUserAccount(tx, user!.id, config().credits.demoLimitMicro);
    const session = await createSession(tx, user!.id);
    await audit(tx, { actorUserId: user!.id, action: 'auth.demo_created', entityType: 'user', entityId: user!.id });
    return { user: user!, session };
  });
}

export async function upsertGoogleUser(profile: { sub: string; email: string | null; name: string | null }) {
  return withTx(async ({ db: tx }) => {
    const [existing] = await tx.select().from(users).where(eq(users.googleSub, profile.sub)).for('update');
    let userId: string;
    if (existing) {
      userId = existing.id;
      await tx.update(users).set({ email: profile.email, name: profile.name }).where(eq(users.id, userId));
    } else {
      const [created] = await tx
        .insert(users)
        .values({ kind: 'google', googleSub: profile.sub, email: profile.email, name: profile.name })
        .returning();
      userId = created!.id;
      await createUserAccount(tx, userId, config().credits.userLimitMicro);
    }
    const session = await createSession(tx, userId);
    await audit(tx, { actorUserId: userId, action: 'auth.login', entityType: 'user', entityId: userId, payload: { provider: 'google' } });
    return { userId, session };
  });
}
