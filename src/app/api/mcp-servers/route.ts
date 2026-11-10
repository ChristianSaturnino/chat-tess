import { NextResponse } from 'next/server';
import { assertSameOrigin, requireUser, route } from '@/server/http';
import { createMcpServer, listMcpServers, mcpServerInput } from '@/server/tools/mcp';

export const GET = route(async () => {
  const user = await requireUser();
  return NextResponse.json({ servers: await listMcpServers(user.id) });
});

export const POST = route(async (req: Request) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const server = await createMcpServer(user.id, mcpServerInput.parse(await req.json()));
  return NextResponse.json({ server: { id: server.id, status: server.status, lastError: server.lastError } }, { status: 201 });
});
