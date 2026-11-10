import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, route } from '@/server/http';
import { previewShare } from '@/server/sharing/shares';

export const GET = route(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  return NextResponse.json(await previewShare(user.id, z.uuid().parse((await ctx.params).id)));
});
