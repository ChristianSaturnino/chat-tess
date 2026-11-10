import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, db } from '@/db/client';
import { contextSummaries, runEvents, runSteps, users } from '@/db/schema';
import { listAudit, setLimit } from '@/server/admin/admin';
import type { SessionUser } from '@/server/auth/session';
import { executeRun } from '@/server/chat/engine';
import { setLlmOverride } from '@/server/llm';
import { FakeAdapter } from '@/server/llm/fake';
import type { LlmAdapter, LlmRequest } from '@/server/llm/types';
import { createConversation, startTurn } from '@/server/runs/commands';
import { stopBoss } from '@/server/runs/queue';
import { getRunTimeline } from '@/server/runs/timeline';
import { createShare, resolveShare, revokeShare, sharedAttachment } from '@/server/sharing/shares';
import { uploadAttachment } from '@/server/storage/attachments';
import { TINY_PNG } from './fixtures';
import { createTestUser, resetDb } from './helpers';

beforeEach(resetDb);
afterEach(() => setLlmOverride(undefined));
afterAll(async () => {
  await stopBoss();
  await closeDb();
});

const filler = (n: number) => ' Detalhe adicional da conversa para ocupar contexto.'.repeat(n);

async function turn(actor: { userId: string }, conversationId: string, text: string) {
  const t = await startTurn(actor, { conversationId, text, idempotencyKey: randomUUID() });
  const result = await executeRun(t.runId, 'w1');
  return { ...t, result };
}

const summaries = (conversationId: string) =>
  db().select().from(contextSummaries).where(eq(contextSummaries.conversationId, conversationId)).orderBy(asc(contextSummaries.version));

describe('compactação', () => {
  it('duas compactações sucessivas preservam fatos antigos e a memória ativa é a enviada ao modelo', async () => {
    const user = await createTestUser();
    const actor = { userId: user.id };
    const conv = await createConversation(actor);

    await turn(actor, conv.id, `Fato 1: o orçamento aprovado é R$ 12.345,67.${filler(20)}`);
    await turn(actor, conv.id, `Fato 2: o fornecedor preferido é a ACME Ltda.${filler(20)}`);
    const t3 = await turn(actor, conv.id, `Fato 3: a entrega deve ocorrer até 30/11.${filler(20)}`);
    expect(t3.result).toBe('completed');

    let rows = await summaries(conv.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary.facts.join(' ')).toContain('R$ 12.345,67');

    await turn(actor, conv.id, `Fato 4: o centro de custo é CC-9081.${filler(20)}`);
    const t5 = await turn(actor, conv.id, `Qual era o orçamento aprovado?${filler(20)}`);
    rows = await summaries(conv.id);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const latest = rows.at(-1)!;
    expect(latest.cutoffSeq).toBeGreaterThan(rows[0]!.cutoffSeq);
    const facts = latest.summary.facts.join(' ');
    expect(facts).toContain('R$ 12.345,67');
    expect(facts).toContain('ACME');

    const started = await db().select().from(runEvents).where(eq(runEvents.runId, t5.runId)).orderBy(asc(runEvents.seq));
    const attempt = started.find((e) => e.type === 'attempt_started')!;
    expect((attempt.payload as { summaryVersion: number }).summaryVersion).toBe(latest.version);

    // Compactação é etapa própria do run, com custo registrado.
    const steps = await db().select().from(runSteps).where(eq(runSteps.kind, 'compaction'));
    expect(steps.every((s) => s.status === 'completed')).toBe(true);
    expect(latest.costMicro).toBeGreaterThan(0);
  });

  it('falha do resumidor mantém o contexto anterior e a resposta segue', async () => {
    const user = await createTestUser();
    const actor = { userId: user.id };
    const conv = await createConversation(actor);
    await turn(actor, conv.id, `Primeiro fato.${filler(25)}`);
    await turn(actor, conv.id, `Segundo fato.${filler(25)}`);

    const normal = new FakeAdapter(0);
    const failing: LlmAdapter = {
      provider: 'test',
      async *stream(req: LlmRequest) {
        if (req.instructions.startsWith('COMPACTADOR_DE_CONTEXTO')) throw new Error('resumidor indisponível');
        yield* normal.stream(req);
      },
    };
    setLlmOverride(failing);
    const t3 = await turn(actor, conv.id, `Terceiro fato.${filler(25)}`);
    expect(t3.result).toBe('completed');
    expect(await summaries(conv.id)).toHaveLength(0);
    const types = (await db().select({ t: runEvents.type }).from(runEvents).where(eq(runEvents.runId, t3.runId))).map((r) => r.t);
    expect(types).toContain('compaction_failed');
  });
});

describe('compartilhamento', () => {
  async function conversationWithAnswer() {
    const user = await createTestUser();
    const actor = { userId: user.id };
    const conv = await createConversation(actor);
    await turn(actor, conv.id, 'Pergunta pública');
    return { user, actor, conv };
  }

  it('snapshot congela o conteúdo; live acompanha; revogação vale na hora', async () => {
    const { actor, conv } = await conversationWithAnswer();
    const snap = await createShare(actor.userId, conv.id, { mode: 'snapshot', attachmentIds: [], expiresInDays: 7 });
    const live = await createShare(actor.userId, conv.id, { mode: 'live', attachmentIds: [], expiresInDays: 7 });
    await turn(actor, conv.id, 'Pergunta posterior');

    const s = await resolveShare(snap.token);
    const l = await resolveShare(live.token);
    expect(s!.projection.messages).toHaveLength(2);
    expect(l!.projection.messages).toHaveLength(4);

    const json = JSON.stringify(s!.projection);
    expect(json).not.toContain('arguments');
    expect(json).not.toContain('encrypted');

    await revokeShare(actor.userId, snap.share.id);
    expect(await resolveShare(snap.token)).toBeNull();
    expect(await resolveShare('token-invalido-com-tamanho-suficiente')).toBeNull();
  });

  it('live fica bloqueado com anexo privado e anexo só abre se liberado', async () => {
    const user = await createTestUser();
    const actor = { userId: user.id };
    const conv = await createConversation(actor);
    const att = await uploadAttachment(user.id, 'planta.png', TINY_PNG);
    const t = await startTurn(actor, { conversationId: conv.id, text: 'veja o anexo', idempotencyKey: randomUUID(), attachmentIds: [att.id] });
    await executeRun(t.runId, 'w1');

    await expect(createShare(user.id, conv.id, { mode: 'live', attachmentIds: [], expiresInDays: 7 })).rejects.toMatchObject({ code: 'live_blocked' });
    const closed = await createShare(user.id, conv.id, { mode: 'snapshot', attachmentIds: [], expiresInDays: 7 });
    const open = await createShare(user.id, conv.id, { mode: 'snapshot', attachmentIds: [att.id], expiresInDays: 7 });
    expect(await sharedAttachment(closed.token, att.id)).toBeNull();
    expect((await sharedAttachment(open.token, att.id))?.id).toBe(att.id);
  });

  it('outro usuário não compartilha nem inspeciona a conversa', async () => {
    const { conv, actor } = await conversationWithAnswer();
    const intruder = await createTestUser();
    await expect(createShare(intruder.id, conv.id, { mode: 'snapshot', attachmentIds: [], expiresInDays: 7 })).rejects.toMatchObject({ status: 404 });
    const [step] = await db().select({ runId: runSteps.runId }).from(runSteps).limit(1);
    await expect(getRunTimeline(intruder.id, step!.runId)).rejects.toMatchObject({ status: 404 });
    expect((await getRunTimeline(actor.userId, step!.runId)).run.costMicro).toBeGreaterThan(0);
  });
});

describe('cotas e auditoria', () => {
  const asSession = (u: typeof users.$inferSelect): SessionUser => ({ id: u.id, kind: u.kind, role: u.role, email: u.email, name: u.name });

  it('admin ajusta cota com auditoria e não pode ficar abaixo do consumo', async () => {
    const [admin] = await db().insert(users).values({ kind: 'google', role: 'admin', email: 'admin@exemplo.test' }).returning();
    const user = await createTestUser(1_000_000);
    const conv = await createConversation({ userId: user.id });
    await turn({ userId: user.id }, conv.id, 'gasta um pouco');

    await expect(setLimit(asSession(admin!), { userId: user.id }, 0, 'teste')).rejects.toMatchObject({ code: 'limit_below_usage' });
    await setLimit(asSession(admin!), { userId: user.id }, 500_000, 'ajuste de demonstração');
    const events = await listAudit(asSession(admin!), { all: true, action: 'credits.' });
    expect(events[0]).toMatchObject({ action: 'credits.limit_changed', actorUserId: admin!.id });
  });

  it('usuário comum vê só a própria auditoria', async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await createConversation({ userId: a.id });
    await createConversation({ userId: b.id });
    const [ua] = await db().select().from(users).where(eq(users.id, a.id));
    const mine = await listAudit(asSession(ua!), {});
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((e) => e.actorUserId === a.id)).toBe(true);
    await expect(listAudit(asSession(ua!), { all: true })).rejects.toMatchObject({ status: 403 });
  });
});
