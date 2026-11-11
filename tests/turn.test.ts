import { randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, db } from '@/db/client';
import { conversations, creditReservations, messages, runEvents, runs, stepAttempts, usageLedger, runSteps } from '@/db/schema';
import { executeRun } from '@/server/chat/engine';
import { balance } from '@/server/credits/credits';
import { setLlmOverride } from '@/server/llm';
import { FakeAdapter } from '@/server/llm/fake';
import type { LlmAdapter, LlmRequest, LlmStreamEvent } from '@/server/llm/types';
import { createConversation, requestCancel, startTurn } from '@/server/runs/commands';
import { stopBoss } from '@/server/runs/queue';
import { createTestUser, resetDb } from './helpers';

beforeEach(resetDb);
afterEach(() => setLlmOverride(undefined));
afterAll(async () => {
  await stopBoss();
  await closeDb();
});

async function setup(limitMicro = 1_000_000) {
  const user = await createTestUser(limitMicro);
  const conv = await createConversation({ userId: user.id });
  return { actor: { userId: user.id }, conv };
}

const getRun = async (id: string) => (await db().select().from(runs).where(eq(runs.id, id)))[0]!;
const getMsg = async (id: string) => (await db().select().from(messages).where(eq(messages.id, id)))[0]!;
const eventTypes = async (runId: string) =>
  (await db().select({ t: runEvents.type }).from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.seq))).map((r) => r.t);

describe('comando de turno', () => {
  it('"Nova conversa" reaproveita a conversa vazia em vez de acumular rascunhos', async () => {
    const { actor, conv } = await setup();
    const again = await createConversation(actor);
    expect(again.id).toBe(conv.id);
    await startTurn(actor, { conversationId: conv.id, text: 'olá', idempotencyKey: randomUUID() });
    const fresh = await createConversation(actor);
    expect(fresh.id).not.toBe(conv.id);
  });

  it('criações simultâneas sem conversa vazia geram uma única conversa', async () => {
    // Conexões já abertas, para que as transações de fato se sobreponham.
    await Promise.all(Array.from({ length: 8 }, () => db().execute(sql`select pg_sleep(0.05)`)));
    for (let round = 0; round < 5; round++) {
      const user = await createTestUser();
      const actor = { userId: user.id };
      const created = await Promise.all(Array.from({ length: 8 }, () => createConversation(actor)));
      expect(new Set(created.map((c) => c.id)).size).toBe(1);
      const rows = await db().select({ id: conversations.id }).from(conversations).where(eq(conversations.userId, user.id));
      expect(rows).toHaveLength(1);
    }
  });

  it('POST repetido com a mesma chave devolve o mesmo run', async () => {
    const { actor, conv } = await setup();
    const key = randomUUID();
    const [a, b] = await Promise.all([
      startTurn(actor, { conversationId: conv.id, text: 'olá', idempotencyKey: key }),
      startTurn(actor, { conversationId: conv.id, text: 'olá', idempotencyKey: key }),
    ]);
    expect(a.runId).toBe(b.runId);
    const all = await db().select().from(runs);
    expect(all).toHaveLength(1);
    expect(await db().select().from(messages)).toHaveLength(2);
  });

  it('mesma chave com payload diferente gera conflito', async () => {
    const { actor, conv } = await setup();
    const key = randomUUID();
    await startTurn(actor, { conversationId: conv.id, text: 'olá', idempotencyKey: key });
    await expect(startTurn(actor, { conversationId: conv.id, text: 'outro', idempotencyKey: key })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('só um run ativo por conversa', async () => {
    const { actor, conv } = await setup();
    await startTurn(actor, { conversationId: conv.id, text: 'um', idempotencyKey: randomUUID() });
    await expect(startTurn(actor, { conversationId: conv.id, text: 'dois', idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'run_active' });
  });

  it('outro usuário não acessa a conversa', async () => {
    const { conv } = await setup();
    const intruder = await createTestUser();
    await expect(startTurn({ userId: intruder.id }, { conversationId: conv.id, text: 'x', idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 404 });
  });
});

describe('engine', () => {
  it('executa o run, persiste texto, liquida créditos e emite eventos', async () => {
    const { actor, conv } = await setup();
    const t = await startTurn(actor, { conversationId: conv.id, text: 'olá', idempotencyKey: randomUUID() });
    expect(await executeRun(t.runId, 'w1')).toBe('completed');

    const msg = await getMsg(t.assistantMessageId);
    expect(msg.status).toBe('completed');
    expect(msg.contentText).toContain('Você escreveu: "olá"');
    expect((await getRun(t.runId)).status).toBe('completed');
    expect(await db().select().from(usageLedger)).toHaveLength(1);
    const b = await balance(db(), actor.userId);
    expect(b!.reservedMicro).toBe(0);
    expect(b!.settledMicro).toBeGreaterThan(0);

    const types = await eventTypes(t.runId);
    expect(types[0]).toBe('run_queued');
    expect(types).toContain('text_delta');
    expect(types.at(-1)).toBe('run_completed');
    // Deltas concatenados reproduzem exatamente o texto persistido.
    const deltas = await db().select().from(runEvents).where(eq(runEvents.type, 'text_delta')).orderBy(asc(runEvents.seq));
    expect(deltas.map((d) => (d.payload as { text: string }).text).join('')).toBe(msg.contentText);

    // Job duplicado após conclusão não faz nada.
    expect(await executeRun(t.runId, 'w2')).toBe('skipped');
  });

  it('saldo insuficiente impede a chamada', async () => {
    const { actor, conv } = await setup(1);
    const t = await startTurn(actor, { conversationId: conv.id, text: 'olá', idempotencyKey: randomUUID() });
    expect(await executeRun(t.runId, 'w1')).toBe('failed');
    expect((await getRun(t.runId)).error?.code).toBe('insufficient_credits');
    expect(await db().select().from(stepAttempts)).toHaveLength(0);
  });

  it('falha 4xx libera a reserva e não repete', async () => {
    const { actor, conv } = await setup();
    const t = await startTurn(actor, { conversationId: conv.id, text: 'x [[fail:4xx]]', idempotencyKey: randomUUID() });
    expect(await executeRun(t.runId, 'w1')).toBe('failed');
    const [res] = await db().select().from(creditReservations);
    expect(res!.status).toBe('released');
    expect((await balance(db(), actor.userId))!.reservedMicro).toBe(0);
  });

  it('falha 5xx no meio do stream: consumo unknown, nova tentativa substitui o texto parcial', async () => {
    const { actor, conv } = await setup();
    const t = await startTurn(actor, { conversationId: conv.id, text: 'x [[fail:5xx]]', idempotencyKey: randomUUID() });
    // As duas tentativas falham no fake → run termina failed; ambas reservas ficam unknown.
    expect(await executeRun(t.runId, 'w1')).toBe('failed');
    const atts = await db().select().from(stepAttempts).orderBy(asc(stepAttempts.attemptNo));
    expect(atts.map((a) => a.status)).toEqual(['unknown', 'unknown']);
    const reservations = await db().select().from(creditReservations);
    expect(reservations.every((r) => r.status === 'unknown')).toBe(true);
    const types = await eventTypes(t.runId);
    expect(types.filter((x) => x === 'attempt_started')).toHaveLength(2);
  });

  it('cancelamento antes de iniciar encerra sem chamada', async () => {
    const { actor, conv } = await setup();
    const t = await startTurn(actor, { conversationId: conv.id, text: 'olá', idempotencyKey: randomUUID() });
    await requestCancel(actor, t.runId);
    expect(await executeRun(t.runId, 'w1')).toBe('cancelled');
    expect((await getMsg(t.assistantMessageId)).status).toBe('cancelled');
  });

  it('worker cai no meio: outro worker assume, tentativa ambígua explicitada, sem texto concatenado', async () => {
    const { actor, conv } = await setup();
    const t = await startTurn(actor, { conversationId: conv.id, text: 'olá', idempotencyKey: randomUUID() });

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const normal = new FakeAdapter(0);
    const adapter: LlmAdapter = {
      provider: 'test',
      async *stream(req: LlmRequest): AsyncIterable<LlmStreamEvent> {
        calls += 1;
        if (calls === 1) {
          yield { type: 'text_delta', text: 'PARCIAL-DO-WORKER-A '.repeat(30) }; // força flush
          await gate; // "trava" até o teste liberar
          yield { type: 'text_delta', text: 'tarde demais' };
          yield {
            type: 'completed',
            status: 'completed',
            usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0 },
            output: [],
            functionCalls: [],
            citations: [],
            webSearchCalls: 0,
          };
          return;
        }
        yield* normal.stream(req);
      },
    };
    setLlmOverride(adapter);

    const workerA = executeRun(t.runId, 'wA');
    // Espera o parcial do worker A ser persistido.
    for (let i = 0; i < 100; i++) {
      if ((await getMsg(t.assistantMessageId)).contentText.includes('PARCIAL')) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    // Simula a queda: lease vence sem heartbeat.
    await db().update(runs).set({ leaseExpiresAt: sql`now() - interval '1 second'` }).where(eq(runs.id, t.runId));

    expect(await executeRun(t.runId, 'wB')).toBe('completed');
    release();
    expect(await workerA).toBe('skipped'); // fencing impede escrita do worker antigo

    const msg = await getMsg(t.assistantMessageId);
    expect(msg.contentText).not.toContain('PARCIAL');
    expect(msg.contentText).not.toContain('tarde demais');
    expect(msg.contentText).toContain('Você escreveu');

    const atts = await db().select().from(stepAttempts).orderBy(asc(stepAttempts.attemptNo));
    expect(atts.map((a) => a.status)).toEqual(['unknown', 'completed']);
    expect(await db().select().from(usageLedger)).toHaveLength(1);
    expect(await db().select().from(runSteps)).toHaveLength(1);
    const types = await eventTypes(t.runId);
    expect(types).toContain('attempt_interrupted');
    expect(types.filter((x) => x === 'run_started')).toHaveLength(2);
  });
});
