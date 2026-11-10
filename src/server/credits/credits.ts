import { and, eq, sql } from 'drizzle-orm';
import { creditAccounts, creditReservations, usageLedger, type UsageSnapshot } from '@/db/schema';
import { db as rootDb, type Db } from '@/db/client';
import { config } from '../config';

export class InsufficientCreditsError extends Error {
  constructor(
    readonly scope: 'user' | 'global',
    readonly availableMicro: number,
    readonly requiredMicro: number,
  ) {
    super(`saldo insuficiente (${scope})`);
  }
}

export async function ensureGlobalAccount(d: Db = rootDb()) {
  await d.insert(creditAccounts).values({ scope: 'global', limitMicro: config().credits.globalLimitMicro }).onConflictDoNothing();
}

export async function createUserAccount(d: Db, userId: string, limitMicro: number) {
  await d.insert(creditAccounts).values({ scope: 'user', userId, limitMicro }).onConflictDoNothing();
}

type AccountRow = { id: string; limit_micro: string; settled_micro: string; reserved_micro: string };

/**
 * Bloqueia contas do usuário e global em ordem fixa (usuário, depois global).
 * Cada transação bloqueia só a própria conta de usuário, então a ordem é consistente entre transações.
 */
async function lockAccounts(d: Db, userId: string) {
  const user = await d.execute<AccountRow>(sql`select id, limit_micro, settled_micro, reserved_micro from credit_accounts where user_id = ${userId} for update`);
  const global = await d.execute<AccountRow>(sql`select id, limit_micro, settled_micro, reserved_micro from credit_accounts where scope = 'global' for update`);
  const u = user.rows[0];
  const g = global.rows[0];
  if (!u || !g) throw new Error('conta de créditos ausente');
  return { user: u, global: g };
}

const available = (a: AccountRow) => Number(a.limit_micro) - Number(a.settled_micro) - Number(a.reserved_micro);

export async function balance(d: Db, userId: string) {
  const [row] = await d.select().from(creditAccounts).where(eq(creditAccounts.userId, userId));
  if (!row) return null;
  return {
    limitMicro: row.limitMicro,
    settledMicro: row.settledMicro,
    reservedMicro: row.reservedMicro,
    availableMicro: row.limitMicro - row.settledMicro - row.reservedMicro,
  };
}

/** Chamar dentro de uma transação. Lança InsufficientCreditsError sem efeitos colaterais. */
export async function reserve(tx: Db, input: { userId: string; attemptId: string; amountMicro: number }) {
  const { user, global } = await lockAccounts(tx, input.userId);
  if (available(user) < input.amountMicro) throw new InsufficientCreditsError('user', available(user), input.amountMicro);
  if (available(global) < input.amountMicro) throw new InsufficientCreditsError('global', available(global), input.amountMicro);

  for (const accountId of [user.id, global.id]) {
    await tx.execute(sql`update credit_accounts set reserved_micro = reserved_micro + ${input.amountMicro}, updated_at = now() where id = ${accountId}`);
  }
  const [res] = await tx
    .insert(creditReservations)
    .values({ attemptId: input.attemptId, userAccountId: user.id, globalAccountId: global.id, amountMicro: input.amountMicro, status: 'pending' })
    .returning();
  return res!;
}

type ReservationRow = { id: string; status: string; amount_micro: string; user_account_id: string; global_account_id: string };

async function lockReservation(tx: Db, attemptId: string) {
  const r = await tx.execute<ReservationRow>(
    sql`select id, status, amount_micro, user_account_id, global_account_id from credit_reservations where attempt_id = ${attemptId} for update`,
  );
  return r.rows[0];
}

/**
 * Liquida uma vez por tentativa: grava o ledger, move reservado → confirmado e libera a diferença.
 * Idempotente: reexecução não cria segundo lançamento. Aceita reserva 'unknown' (reconciliação posterior).
 */
export async function settle(
  tx: Db,
  input: {
    attemptId: string;
    userId: string;
    model: string;
    pricingVersion: string;
    usage: UsageSnapshot;
    webSearchCalls?: number;
    toolFeeMicro?: number;
    costMicro: number;
  },
): Promise<{ settled: boolean }> {
  const res = await lockReservation(tx, input.attemptId);
  if (!res) throw new Error('reserva inexistente para a tentativa');
  if (res.status === 'settled' || res.status === 'released') return { settled: false };

  const inserted = await tx
    .insert(usageLedger)
    .values({
      attemptId: input.attemptId,
      reservationId: res.id,
      userId: input.userId,
      model: input.model,
      pricingVersion: input.pricingVersion,
      inputTokens: input.usage.inputTokens,
      cachedInputTokens: input.usage.cachedInputTokens,
      outputTokens: input.usage.outputTokens,
      reasoningTokens: input.usage.reasoningTokens,
      webSearchCalls: input.webSearchCalls ?? 0,
      toolFeeMicro: input.toolFeeMicro ?? 0,
      costMicro: input.costMicro,
    })
    .onConflictDoNothing()
    .returning({ id: usageLedger.id });
  if (inserted.length === 0) return { settled: false };

  const amount = Number(res.amount_micro);
  for (const accountId of [res.user_account_id, res.global_account_id]) {
    await tx.execute(sql`update credit_accounts
      set reserved_micro = reserved_micro - ${amount}, settled_micro = settled_micro + ${input.costMicro}, updated_at = now()
      where id = ${accountId}`);
  }
  await tx
    .update(creditReservations)
    .set({ status: 'settled', settledMicro: input.costMicro, updatedAt: new Date() })
    .where(eq(creditReservations.id, res.id));
  return { settled: true };
}

/** Libera a reserva quando há evidência de que não houve cobrança (ex.: 4xx antes do processamento). */
export async function release(tx: Db, attemptId: string) {
  const res = await lockReservation(tx, attemptId);
  if (!res || (res.status !== 'pending' && res.status !== 'unknown')) return;
  const amount = Number(res.amount_micro);
  for (const accountId of [res.user_account_id, res.global_account_id]) {
    await tx.execute(sql`update credit_accounts set reserved_micro = reserved_micro - ${amount}, updated_at = now() where id = ${accountId}`);
  }
  await tx.update(creditReservations).set({ status: 'released', updatedAt: new Date() }).where(eq(creditReservations.id, res.id));
}

/** Resultado/consumo desconhecido: mantém a reserva até reconciliação. */
export async function markUnknown(tx: Db, attemptId: string) {
  await tx
    .update(creditReservations)
    .set({ status: 'unknown', updatedAt: new Date() })
    .where(and(eq(creditReservations.attemptId, attemptId), eq(creditReservations.status, 'pending')));
}
