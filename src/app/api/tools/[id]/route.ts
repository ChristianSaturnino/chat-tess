import { NextResponse } from 'next/server';
import { z } from 'zod';
import { assertSameOrigin, requireUser, route } from '@/server/http';
import { deleteHttpTool } from '@/server/tools/http-tools';

export const DELETE = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  const user = await requireUser();
  await deleteHttpTool(user.id, z.uuid().parse((await ctx.params).id));
  return NextResponse.json({ ok: true });
});
