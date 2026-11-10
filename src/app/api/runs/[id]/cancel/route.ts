import { NextResponse } from 'next/server';
import { z } from 'zod';
import { assertSameOrigin, requireUser, route } from '@/server/http';
import { requestCancel } from '@/server/runs/commands';

export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const runId = z.uuid().parse((await ctx.params).id);
  return NextResponse.json(await requestCancel({ userId: user.id }, runId), { status: 202 });
});
