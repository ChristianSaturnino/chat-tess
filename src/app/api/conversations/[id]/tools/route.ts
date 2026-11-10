import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/db/client';
import { assertSameOrigin, requireUser, route } from '@/server/http';
import { listConversationTools, setConversationTool } from '@/server/tools/registry';

export const GET = route(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const id = z.uuid().parse((await ctx.params).id);
  return NextResponse.json({ tools: await listConversationTools(db(), user.id, id) });
});

const body = z.object({ toolKey: z.string().min(3).max(100), enabled: z.boolean() });

export const PUT = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const id = z.uuid().parse((await ctx.params).id);
  const { toolKey, enabled } = body.parse(await req.json());
  await setConversationTool(user.id, id, toolKey, enabled);
  return NextResponse.json({ tools: await listConversationTools(db(), user.id, id) });
});
