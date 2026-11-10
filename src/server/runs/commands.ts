import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { conversations, messages, runs, ACTIVE_RUN_STATUS, type RunConfigSnapshot } from '@/db/schema';
import { db, isUniqueViolation, withTx, type Db } from '@/db/client';
import type { ConversationSnapshotDto, MessageDto } from '@/shared/events';
import { audit } from '../audit/audit';
import { config } from '../config';
import { AppError, notFound } from '../errors';
import { SYSTEM_PROMPT_VERSION } from '../chat/context';
import { appendEvent } from './events';
import { enqueueRunInTx } from './queue';

type Actor = { userId: string };

async function ownedConversation(d: Db, actor: Actor, conversationId: string, lock = false) {
  const q = d
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, actor.userId)));
  const [conv] = lock ? await q.for('update') : await q;
  // 404 também para conversa de outro usuário: não revelar existência.
  if (!conv) throw notFound('conversa');
  return conv;
}

export async function createConversation(actor: Actor) {
  return withTx(async ({ db: tx }) => {
    const [conv] = await tx.insert(conversations).values({ userId: actor.userId }).returning();
    await audit(tx, { actorUserId: actor.userId, action: 'conversation.create', entityType: 'conversation', entityId: conv!.id });
    return conv!;
  });
}

export async function listConversations(actor: Actor) {
  return db()
    .select({ id: conversations.id, title: conversations.title, updatedAt: conversations.updatedAt })
    .from(conversations)
    .where(eq(conversations.userId, actor.userId))
    .orderBy(desc(conversations.updatedAt))
    .limit(100);
}

export type StartTurnInput = { conversationId: string; text: string; idempotencyKey: string };
export type StartTurnResult = { runId: string; userMessageId: string; assistantMessageId: string; replayed: boolean };

const requestHash = (input: StartTurnInput) =>
  createHash('sha256').update(JSON.stringify({ c: input.conversationId, t: input.text })).digest('hex');

async function findByIdempotency(d: Db, actor: Actor, input: StartTurnInput, hash: string): Promise<StartTurnResult | null> {
  const [existing] = await d
    .select()
    .from(runs)
    .where(and(eq(runs.userId, actor.userId), eq(runs.idempotencyKey, input.idempotencyKey)));
  if (!existing) return null;
  if (existing.requestHash !== hash) {
    throw new AppError(409, 'idempotency_conflict', 'chave de idempotência reutilizada com outro conteúdo');
  }
  return { runId: existing.id, userMessageId: existing.userMessageId, assistantMessageId: existing.assistantMessageId, replayed: true };
}

/**
 * Comando de turno: uma transação curta cria mensagem do usuário, placeholder do assistant,
 * run, evento inicial, auditoria e job. Tudo confirma ou falha junto.
 */
export async function startTurn(actor: Actor, input: StartTurnInput): Promise<StartTurnResult> {
  const cfg = config();
  const text = input.text.trim();
  if (!text) throw new AppError(400, 'empty_message', 'mensagem vazia');
  if (text.length > cfg.limits.maxMessageChars) throw new AppError(413, 'message_too_long', 'mensagem longa demais');
  const hash = requestHash({ ...input, text });

  const replay = await findByIdempotency(db(), actor, input, hash);
  if (replay) return replay;

  try {
    return await withTx(async ({ db: tx, client }) => {
      const conv = await ownedConversation(tx, actor, input.conversationId, true);

      const [recent] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(runs)
        .where(and(eq(runs.userId, actor.userId), gte(runs.createdAt, sql`now() - interval '1 minute'`)));
      if ((recent?.n ?? 0) >= cfg.limits.turnsPerMinute) {
        throw new AppError(429, 'rate_limited', 'muitas mensagens por minuto');
      }

      const runId = randomUUID();
      const traceId = randomUUID();
      const userSeq = conv.nextSeq;
      const [userMsg] = await tx
        .insert(messages)
        .values({ conversationId: conv.id, seq: userSeq, role: 'user', status: 'completed', contentText: text, runId })
        .returning({ id: messages.id });
      const [assistantMsg] = await tx
        .insert(messages)
        .values({ conversationId: conv.id, seq: userSeq + 1, role: 'assistant', status: 'pending', runId })
        .returning({ id: messages.id });

      const snapshot: RunConfigSnapshot = {
        provider: cfg.llm.provider,
        model: cfg.llm.model,
        maxOutputTokens: cfg.llm.maxOutputTokens,
        maxLlmAttempts: cfg.llm.maxLlmAttempts,
        pricingVersion: cfg.llm.pricing.version,
        systemPromptVersion: SYSTEM_PROMPT_VERSION,
      };
      await tx.insert(runs).values({
        id: runId,
        conversationId: conv.id,
        userId: actor.userId,
        userMessageId: userMsg!.id,
        assistantMessageId: assistantMsg!.id,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
        status: 'queued',
        traceId,
        configSnapshot: snapshot,
      });
      await tx
        .update(conversations)
        .set({ nextSeq: userSeq + 2, updatedAt: new Date(), title: conv.title ?? text.slice(0, 60) })
        .where(eq(conversations.id, conv.id));

      await appendEvent(tx, runId, 'run_queued', { userMessageId: userMsg!.id, assistantMessageId: assistantMsg!.id });
      await audit(tx, {
        actorUserId: actor.userId,
        action: 'message.create',
        entityType: 'message',
        entityId: userMsg!.id,
        runId,
        traceId,
        payload: { conversationId: conv.id, chars: text.length },
      });
      await enqueueRunInTx(client, runId);

      return { runId, userMessageId: userMsg!.id, assistantMessageId: assistantMsg!.id, replayed: false };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'runs_user_idempotency_uq')) {
      // Corrida entre dois POSTs com a mesma chave: devolve o vencedor.
      const winner = await findByIdempotency(db(), actor, input, hash);
      if (winner) return winner;
    }
    if (isUniqueViolation(err, 'runs_one_active_per_conversation_uq')) {
      throw new AppError(409, 'run_active', 'já existe uma resposta em andamento nesta conversa');
    }
    throw err;
  }
}

export async function requestCancel(actor: Actor, runId: string) {
  return withTx(async ({ db: tx }) => {
    const [run] = await tx.select().from(runs).where(and(eq(runs.id, runId), eq(runs.userId, actor.userId))).for('update');
    if (!run) throw notFound('execução');
    if (!ACTIVE_RUN_STATUS.includes(run.status)) return { status: run.status };
    if (run.cancelRequested) return { status: run.status };
    await tx.update(runs).set({ cancelRequested: true }).where(eq(runs.id, runId));
    await appendEvent(tx, runId, 'cancel_requested', {});
    await audit(tx, { actorUserId: actor.userId, action: 'run.cancel_requested', entityType: 'run', entityId: runId, runId, traceId: run.traceId });
    return { status: run.status };
  });
}

export async function getOwnedRun(actor: Actor, runId: string) {
  const [run] = await db().select().from(runs).where(and(eq(runs.id, runId), eq(runs.userId, actor.userId)));
  if (!run) throw notFound('execução');
  return run;
}

/**
 * Snapshot consistente: texto das mensagens e cursor do run lidos no mesmo instante
 * (REPEATABLE READ). Deltas e atualização da mensagem são gravados na mesma transação pelo worker,
 * então o cliente continua do cursor sem duplicar nem perder texto.
 */
export async function getConversationSnapshot(actor: Actor, conversationId: string): Promise<ConversationSnapshotDto> {
  return withTx(
    async ({ db: tx }) => {
      const conv = await ownedConversation(tx, actor, conversationId);
      const msgs = await tx.select().from(messages).where(eq(messages.conversationId, conv.id)).orderBy(asc(messages.seq));
      const [active] = await tx
        .select({ id: runs.id, status: runs.status, lastEventSeq: runs.eventSeq })
        .from(runs)
        .where(and(eq(runs.conversationId, conv.id), inArray(runs.status, ACTIVE_RUN_STATUS)));
      return {
        conversation: { id: conv.id, title: conv.title },
        messages: msgs.map(
          (m): MessageDto => ({
            id: m.id,
            seq: m.seq,
            role: m.role,
            status: m.status,
            contentText: m.contentText,
            runId: m.runId,
            createdAt: m.createdAt.toISOString(),
          }),
        ),
        activeRun: active ?? null,
      };
    },
    { isolation: 'repeatable read' },
  );
}
