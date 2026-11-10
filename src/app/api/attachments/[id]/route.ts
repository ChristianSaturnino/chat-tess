import { z } from 'zod';
import { requireUser, route } from '@/server/http';
import { getOwnedAttachment } from '@/server/storage/attachments';
import { storage } from '@/server/storage/storage';

/** Download autorizado a cada request; sem URLs assinadas que sobrevivam a revogação. */
export const GET = route(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const id = z.uuid().parse((await ctx.params).id);
  const att = await getOwnedAttachment(user.id, id);
  const body = await storage().get(att.storageKey);
  return new Response(new Uint8Array(body), {
    headers: {
      'Content-Type': att.mimeType,
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      'Cache-Control': 'private, no-store',
    },
  });
});
