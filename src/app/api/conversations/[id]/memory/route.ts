import { NextResponse } from 'next/server';
import { z } from 'zod';
import { renderSummary } from '@/server/chat/context';
import { requireUser, route } from '@/server/http';
import { getConversationMemory } from '@/server/runs/timeline';

export const GET = route(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const versions = await getConversationMemory(user.id, z.uuid().parse((await ctx.params).id));
  // `rendered` é exatamente o texto enviado ao modelo como memória.
  return NextResponse.json({ versions: versions.map((v) => ({ ...v, rendered: renderSummary(v.summary) })) });
});
