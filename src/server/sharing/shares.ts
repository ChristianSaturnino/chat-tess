import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lte } from 'drizzle-orm';
import { z } from 'zod';
import { attachments, conversations, messageSources, messages, runSteps, shares, sources, toolCalls, type ShareProjection } from '@/db/schema';
import { db, withTx, type Db } from '@/db/client';
import { audit } from '../audit/audit';
import { hashToken } from '../auth/session';
import { AppError, notFound } from '../errors';
import { runSummaries } from '../runs/timeline';
import { conversationHasPrivateData } from '../sources/sources';

/**
 * Projeção pública: só mensagens concluídas, texto final, fontes (título/tipo; URL apenas de páginas
 * públicas) e etapas sem argumentos nem resultados. Nada de raw do provider, reasoning, secrets
 * ou auditoria. Referências a Drive/Gmail não concedem acesso aos originais.
 */
export async function buildProjection(d: Db, conversationId: string, maxSeq?: number): Promise<ShareProjection> {
  const [conv] = await d.select({ title: conversations.title }).from(conversations).where(eq(conversations.id, conversationId));
  const conds = [eq(messages.conversationId, conversationId), eq(messages.status, 'completed')];
  if (maxSeq !== undefined) conds.push(lte(messages.seq, maxSeq));
  const msgs = await d.select().from(messages).where(and(...conds)).orderBy(asc(messages.seq));
  // Pergunta sem resposta concluída fica de fora junto com a resposta.
  const answered = new Set(msgs.filter((m) => m.role === 'assistant').map((m) => m.runId));
  const visible = msgs.filter((m) => m.role === 'assistant' || answered.has(m.runId));
  const ids = visible.map((m) => m.id);
  const runIds = [...new Set(visible.filter((m) => m.role === 'assistant' && m.runId).map((m) => m.runId!))];

  const atts = ids.length
    ? await d
        .select({ id: attachments.id, messageId: attachments.messageId, filename: attachments.filename, mimeType: attachments.mimeType })
        .from(attachments)
        .where(inArray(attachments.messageId, ids))
    : [];
  const srcs = ids.length
    ? await d
        .select({ messageId: messageSources.messageId, cited: messageSources.cited, label: sources.label, kind: sources.kind, title: sources.title, url: sources.url })
        .from(messageSources)
        .innerJoin(sources, eq(sources.id, messageSources.sourceId))
        .where(inArray(messageSources.messageId, ids))
        .orderBy(asc(sources.label))
    : [];
  const steps = runIds.length
    ? await d
        .select({ runId: runSteps.runId, seq: runSteps.seq, kind: runSteps.kind, status: runSteps.status, startedAt: runSteps.startedAt, finishedAt: runSteps.finishedAt, toolName: toolCalls.name })
        .from(runSteps)
        .leftJoin(toolCalls, eq(toolCalls.stepId, runSteps.id))
        .where(inArray(runSteps.runId, runIds))
        .orderBy(asc(runSteps.seq))
    : [];
  const summaries = await runSummaries(d, runIds);

  return {
    title: conv?.title ?? null,
    messages: visible.map((m) => ({
      role: m.role,
      seq: m.seq,
      contentText: m.contentText,
      createdAt: m.createdAt.toISOString(),
      attachments: atts.filter((a) => a.messageId === m.id).map(({ id, filename, mimeType }) => ({ id, filename, mimeType })),
      sources: srcs
        .filter((s) => s.messageId === m.id)
        .map((s) => ({ label: s.label, kind: s.kind, title: s.title, url: s.kind === 'web' ? s.url : null, cited: s.cited })),
      execution:
        m.role === 'assistant' && m.runId
          ? {
              steps: steps
                .filter((s) => s.runId === m.runId)
                .map((s) => ({
                  kind: s.kind,
                  name: s.toolName ?? null,
                  status: s.status,
                  durationMs: s.finishedAt ? s.finishedAt.getTime() - s.startedAt.getTime() : null,
                })),
              costMicro: summaries.get(m.runId)?.costMicro ?? 0,
            }
          : null,
    })),
  };
}

async function ownedConversation(userId: string, conversationId: string) {
  const [conv] = await db().select().from(conversations).where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)));
  if (!conv) throw notFound('conversa');
  return conv;
}

/** O que seria publicado, para revisão antes de criar o link. */
export async function previewShare(userId: string, conversationId: string) {
  await ownedConversation(userId, conversationId);
  const projection = await buildProjection(db(), conversationId);
  const privateData = await conversationHasPrivateData(db(), conversationId);
  return {
    projection,
    privateData,
    liveAllowed: !privateData,
    attachments: projection.messages.flatMap((m) => m.attachments),
    privateSources: projection.messages.flatMap((m) => m.sources).filter((s) => s.kind === 'drive' || s.kind === 'gmail' || s.kind === 'attachment').length,
  };
}

export const createShareInput = z.object({
  mode: z.enum(['snapshot', 'live']),
  /** Anexos explicitamente liberados para download público; padrão: nenhum. */
  attachmentIds: z.array(z.uuid()).max(20).default([]),
  expiresInDays: z.number().int().min(1).max(30).nullable().default(7),
});

export async function createShare(userId: string, conversationId: string, input: z.infer<typeof createShareInput>) {
  await ownedConversation(userId, conversationId);
  return withTx(async ({ db: tx }) => {
    if (input.mode === 'live' && (await conversationHasPrivateData(tx, conversationId))) {
      throw new AppError(409, 'live_blocked', 'compartilhamento live fica indisponível em conversas com anexos ou fontes privadas');
    }
    const projection = await buildProjection(tx, conversationId);
    if (!projection.messages.length) throw new AppError(400, 'nothing_to_share', 'nenhuma mensagem concluída para compartilhar');
    const available = new Set(projection.messages.flatMap((m) => m.attachments.map((a) => a.id)));
    const allowed = input.attachmentIds.filter((id) => available.has(id));
    if (allowed.length !== input.attachmentIds.length) throw new AppError(400, 'invalid_attachment', 'anexo fora da conversa');

    const token = randomBytes(32).toString('base64url');
    const [row] = await tx
      .insert(shares)
      .values({
        conversationId,
        userId,
        tokenHash: hashToken(token),
        mode: input.mode,
        snapshot: input.mode === 'snapshot' ? projection : null,
        allowedAttachmentIds: allowed,
        expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
      })
      .returning();
    await audit(tx, {
      actorUserId: userId,
      action: 'share.create',
      entityType: 'share',
      entityId: row!.id,
      payload: { conversationId, mode: input.mode, messages: projection.messages.length, attachments: allowed.length, expiresAt: row!.expiresAt },
    });
    return { share: row!, token };
  });
}

export async function listShares(userId: string, conversationId: string) {
  await ownedConversation(userId, conversationId);
  const rows = await db().select().from(shares).where(eq(shares.conversationId, conversationId)).orderBy(desc(shares.createdAt));
  return rows.map((s) => ({
    id: s.id,
    mode: s.mode,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    revokedAt: s.revokedAt,
    attachments: s.allowedAttachmentIds.length,
    messages: s.snapshot?.messages.length ?? null,
  }));
}

export async function revokeShare(userId: string, shareId: string) {
  await withTx(async ({ db: tx }) => {
    const r = await tx
      .update(shares)
      .set({ revokedAt: new Date() })
      .where(and(eq(shares.id, shareId), eq(shares.userId, userId), isNull(shares.revokedAt)))
      .returning({ id: shares.id, conversationId: shares.conversationId });
    if (!r.length) throw notFound('compartilhamento');
    await audit(tx, { actorUserId: userId, action: 'share.revoke', entityType: 'share', entityId: shareId, payload: { conversationId: r[0]!.conversationId } });
  });
}

/** Valida o token a cada acesso: revogação e expiração valem imediatamente. */
export async function resolveShare(token: string) {
  if (!token || token.length < 20) return null;
  const [s] = await db().select().from(shares).where(eq(shares.tokenHash, hashToken(token)));
  if (!s || s.revokedAt || (s.expiresAt && s.expiresAt < new Date())) return null;
  if (s.mode === 'snapshot') return { share: s, projection: s.snapshot! };
  // Live deixa de publicar se a conversa passou a conter dado privado depois da criação.
  if (await conversationHasPrivateData(db(), s.conversationId)) return null;
  return { share: s, projection: await buildProjection(db(), s.conversationId) };
}

export async function sharedAttachment(token: string, attachmentId: string) {
  const resolved = await resolveShare(token);
  if (!resolved || !resolved.share.allowedAttachmentIds.includes(attachmentId)) return null;
  const inProjection = resolved.projection.messages.some((m) => m.attachments.some((a) => a.id === attachmentId));
  if (!inProjection) return null;
  const [att] = await db().select().from(attachments).where(and(eq(attachments.id, attachmentId), eq(attachments.status, 'attached')));
  return att ?? null;
}
