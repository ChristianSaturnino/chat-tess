import { NextResponse } from 'next/server';
import { z } from 'zod';
import { assertSameOrigin, requireUser, route } from '@/server/http';
import { syncMcpServer } from '@/server/tools/mcp';

export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const s = await syncMcpServer(user.id, z.uuid().parse((await ctx.params).id));
  return NextResponse.json({ server: { id: s.id, catalogVersion: s.catalogVersion, tools: s.catalog.length } });
});
