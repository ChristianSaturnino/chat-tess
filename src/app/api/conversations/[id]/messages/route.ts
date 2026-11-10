import { NextResponse } from 'next/server';
import { z } from 'zod';
import { assertSameOrigin, requireUser, route } from '@/server/http';
import { startTurn } from '@/server/runs/commands';

const body = z.object({
  text: z.string().min(1).max(20_000),
  idempotencyKey: z.string().min(8).max(100),
});

export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const conversationId = z.uuid().parse((await ctx.params).id);
  const input = body.parse(await req.json());
  const result = await startTurn({ userId: user.id }, { conversationId, ...input });
  return NextResponse.json(result, { status: result.replayed ? 200 : 202 });
});
