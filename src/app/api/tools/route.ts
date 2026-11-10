import { NextResponse } from 'next/server';
import { assertSameOrigin, requireUser, route } from '@/server/http';
import { createHttpTool, httpToolInput, listHttpTools } from '@/server/tools/http-tools';

export const GET = route(async () => {
  const user = await requireUser();
  return NextResponse.json({ tools: await listHttpTools(user.id) });
});

export const POST = route(async (req: Request) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const tool = await createHttpTool(user.id, httpToolInput.parse(await req.json()));
  return NextResponse.json({ tool: { id: tool.id, name: tool.name } }, { status: 201 });
});
