import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, route } from '@/server/http';
import { getConversationSnapshot } from '@/server/runs/commands';

export const GET = route(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const id = z.uuid().parse((await ctx.params).id);
  return NextResponse.json(await getConversationSnapshot({ userId: user.id }, id));
});
