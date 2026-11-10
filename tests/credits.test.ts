import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, db, withTx } from '@/db/client';
import { conversations, messages, runSteps, runs, stepAttempts, usageLedger } from '@/db/schema';
import { balance, InsufficientCreditsError, reserve, settle } from '@/server/credits/credits';
import { createTestUser, resetDb } from './helpers';

/** Cria a cadeia mínima até uma tentativa (FK da reserva). */
async function makeAttempt(userId: string) {
  const [conv] = await db().insert(conversations).values({ userId }).returning();
  const runId = randomUUID();
  const [um] = await db().insert(messages).values({ conversationId: conv!.id, seq: 1, role: 'user', status: 'completed' }).returning();
  await db().insert(runs).values({
    id: runId,
    conversationId: conv!.id,
    userId,
    userMessageId: um!.id,
    assistantMessageId: um!.id,
    idempotencyKey: randomUUID(),
    requestHash: 'x',
    status: 'completed',
    traceId: 't',
    configSnapshot: { provider: 'fake', model: 'm', maxOutputTokens: 1, maxLlmAttempts: 1, pricingVersion: 'v', systemPromptVersion: 'v' },
  });
  const [step] = await db().insert(runSteps).values({ runId, seq: 1, kind: 'llm_call', status: 'running' }).returning();
  const [att] = await db().insert(stepAttempts).values({ stepId: step!.id, attemptNo: 1, status: 'running', runVersion: 1 }).returning();
  return att!.id;
}

beforeEach(resetDb);
afterAll(closeDb);

describe('créditos', () => {
  it('reservas concorrentes não ultrapassam o saldo', async () => {
    const user = await createTestUser(300);
    const attempts = await Promise.all(Array.from({ length: 10 }, () => makeAttempt(user.id)));
    const results = await Promise.allSettled(
      attempts.map((attemptId) => withTx(({ db: tx }) => reserve(tx, { userId: user.id, attemptId, amountMicro: 100 }))),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(ok).toBe(3);
    expect(rejected.every((r) => (r as PromiseRejectedResult).reason instanceof InsufficientCreditsError)).toBe(true);
    const b = await balance(db(), user.id);
    expect(b).toMatchObject({ reservedMicro: 300, availableMicro: 0 });
  });

  it('cap global bloqueia mesmo com saldo do usuário', async () => {
    await db().execute(sql`update credit_accounts set limit_micro = 50 where scope = 'global'`);
    const user = await createTestUser(1000);
    const attemptId = await makeAttempt(user.id);
    await expect(withTx(({ db: tx }) => reserve(tx, { userId: user.id, attemptId, amountMicro: 100 }))).rejects.toMatchObject({ scope: 'global' });
  });

  it('liquidação repetida gera um único lançamento e libera a diferença', async () => {
    const user = await createTestUser(1000);
    const attemptId = await makeAttempt(user.id);
    await withTx(({ db: tx }) => reserve(tx, { userId: user.id, attemptId, amountMicro: 400 }));
    const input = {
      attemptId,
      userId: user.id,
      model: 'm',
      pricingVersion: 'v',
      usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0 },
      costMicro: 120,
    };
    const results = await Promise.all([1, 2, 3].map(() => withTx(({ db: tx }) => settle(tx, input))));
    expect(results.filter((r) => r.settled)).toHaveLength(1);
    const rows = await db().select().from(usageLedger).where(eq(usageLedger.attemptId, attemptId));
    expect(rows).toHaveLength(1);
    expect(await balance(db(), user.id)).toMatchObject({ reservedMicro: 0, settledMicro: 120, availableMicro: 880 });
  });

  it('ledger é append-only', async () => {
    const user = await createTestUser(1000);
    const attemptId = await makeAttempt(user.id);
    await withTx(({ db: tx }) => reserve(tx, { userId: user.id, attemptId, amountMicro: 10 }));
    await withTx(({ db: tx }) =>
      settle(tx, { attemptId, userId: user.id, model: 'm', pricingVersion: 'v', usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0 }, costMicro: 5 }),
    );
    const err = await db()
      .execute(sql`update usage_ledger set cost_micro = 0`)
      .then(() => null, (e: unknown) => e as { cause?: Error });
    expect(err?.cause?.message).toMatch(/append-only/);
  });
});
