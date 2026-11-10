import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { attachments } from '@/db/schema';
import { db, withTx, type Db } from '@/db/client';
import { audit } from '../audit/audit';
import { AppError, notFound } from '../errors';
import { logger } from '../logger';
import { storage } from './storage';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

/** Tipo real pelos primeiros bytes. O Content-Type declarado pelo navegador é ignorado. */
export function sniffMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  return null;
}

const safeName = (name: string) => name.replace(/[^\p{L}\p{N}._ -]+/gu, '_').slice(0, 120) || 'arquivo';

export async function uploadAttachment(userId: string, filename: string, body: Buffer) {
  if (body.length === 0) throw new AppError(400, 'empty_file', 'arquivo vazio');
  if (body.length > MAX_ATTACHMENT_BYTES) throw new AppError(413, 'file_too_large', 'arquivo maior que 10 MB');
  const mimeType = sniffMime(body);
  if (!mimeType) throw new AppError(415, 'unsupported_type', 'tipo não suportado: envie PNG, JPEG, GIF, WEBP ou PDF');

  const sha256 = createHash('sha256').update(body).digest('hex');
  const storageKey = `${userId}/${randomUUID()}`;
  await storage().put(storageKey, body, mimeType);
  try {
    return await withTx(async ({ db: tx }) => {
      const [row] = await tx
        .insert(attachments)
        .values({ userId, storageKey, filename: safeName(filename), mimeType, sizeBytes: body.length, sha256, status: 'ready' })
        .returning();
      await audit(tx, { actorUserId: userId, action: 'attachment.upload', entityType: 'attachment', entityId: row!.id, payload: { mimeType, sizeBytes: body.length, sha256 } });
      return row!;
    });
  } catch (err) {
    await storage().delete(storageKey).catch(() => {});
    throw err;
  }
}

/** Vincula anexos à mensagem dentro da transação do turno. Só anexos do próprio usuário, ainda soltos. */
export async function attachToMessage(tx: Db, userId: string, messageId: string, ids: string[]) {
  if (!ids.length) return [];
  if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new AppError(400, 'too_many_attachments', `no máximo ${MAX_ATTACHMENTS_PER_MESSAGE} anexos por mensagem`);
  const rows = await tx
    .update(attachments)
    .set({ messageId, status: 'attached' })
    .where(and(inArray(attachments.id, ids), eq(attachments.userId, userId), eq(attachments.status, 'ready'), isNull(attachments.messageId)))
    .returning({ id: attachments.id });
  if (rows.length !== new Set(ids).size) throw new AppError(400, 'invalid_attachment', 'anexo inexistente, de outro usuário ou já usado');
  return rows;
}

export async function getOwnedAttachment(userId: string, id: string) {
  const [row] = await db().select().from(attachments).where(and(eq(attachments.id, id), eq(attachments.userId, userId)));
  if (!row || row.status === 'deleted') throw notFound('anexo');
  return row;
}

/** Uploads nunca vinculados a mensagem são removidos após o prazo. */
export async function cleanupOrphanAttachments(olderThanHours = 24) {
  const orphans = await db()
    .select()
    .from(attachments)
    .where(and(eq(attachments.status, 'ready'), isNull(attachments.messageId), lt(attachments.createdAt, sql`now() - make_interval(hours => ${olderThanHours})`)))
    .limit(100);
  for (const a of orphans) {
    try {
      await storage().delete(a.storageKey);
      await db().update(attachments).set({ status: 'deleted' }).where(eq(attachments.id, a.id));
    } catch (err) {
      logger.warn({ err, attachmentId: a.id }, 'limpeza de anexo falhou');
    }
  }
  return orphans.length;
}
