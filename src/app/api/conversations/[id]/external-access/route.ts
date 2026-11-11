import { NextResponse } from 'next/server';
import { z } from 'zod';
import { assertSameOrigin, requireUser, route } from '@/server/http';
import { setExternalAccess } from '@/server/runs/commands';

const body = z.object({ allowed: z.boolean() });

export const PUT = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const id = z.uuid().parse((await ctx.params).id);
  const { allowed } = body.parse(await req.json());
  await setExternalAccess({ userId: user.id }, id, allowed);
  return NextResponse.json({ ok: true });
});
