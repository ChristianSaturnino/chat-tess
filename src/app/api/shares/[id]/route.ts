import { NextResponse } from 'next/server';
import { z } from 'zod';
import { assertSameOrigin, requireUser, route } from '@/server/http';
import { revokeShare } from '@/server/sharing/shares';

export const DELETE = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  const user = await requireUser();
  await revokeShare(user.id, z.uuid().parse((await ctx.params).id));
  return NextResponse.json({ ok: true });
});
