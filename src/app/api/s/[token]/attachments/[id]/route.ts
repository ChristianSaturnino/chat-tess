import { z } from 'zod';
import { notFound } from '@/server/errors';
import { route } from '@/server/http';
import { sharedAttachment } from '@/server/sharing/shares';
import { storage } from '@/server/storage/storage';

/** Download público autorizado pelo share a cada request: revogado ou expirado deixa de funcionar na hora. */
export const GET = route(async (_req: Request, ctx: { params: Promise<{ token: string; id: string }> }) => {
  const { token, id } = await ctx.params;
  const att = await sharedAttachment(token, z.uuid().parse(id));
  if (!att) throw notFound('anexo');
  const body = await storage().get(att.storageKey);
  return new Response(new Uint8Array(body), {
    headers: {
      'Content-Type': att.mimeType,
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
});
