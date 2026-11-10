import { NextResponse } from 'next/server';
import { z } from 'zod';
import { config } from '@/server/config';
import { assertSameOrigin, requireUser, route } from '@/server/http';
import { createShare, createShareInput, listShares } from '@/server/sharing/shares';

export const GET = route(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  return NextResponse.json({ shares: await listShares(user.id, z.uuid().parse((await ctx.params).id)) });
});

export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const id = z.uuid().parse((await ctx.params).id);
  const { share, token } = await createShare(user.id, id, createShareInput.parse(await req.json()));
  // O token aparece só nesta resposta; o banco guarda apenas o hash.
  return NextResponse.json({ id: share.id, url: `${config().env.APP_URL}/s/${token}`, expiresAt: share.expiresAt }, { status: 201 });
});
