import { NextResponse } from 'next/server';
import { z } from 'zod';
import { disconnect } from '@/server/connectors/google/oauth';
import { assertSameOrigin, requireUser, route } from '@/server/http';

export const DELETE = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  const user = await requireUser();
  await disconnect(user.id, z.uuid().parse((await ctx.params).id));
  return NextResponse.json({ ok: true });
});
