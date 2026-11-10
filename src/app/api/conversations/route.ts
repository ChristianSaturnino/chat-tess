import { NextResponse } from 'next/server';
import { assertSameOrigin, requireUser, route } from '@/server/http';
import { createConversation, listConversations } from '@/server/runs/commands';

export const GET = route(async () => {
  const user = await requireUser();
  return NextResponse.json({ conversations: await listConversations({ userId: user.id }) });
});

export const POST = route(async (req: Request) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const conv = await createConversation({ userId: user.id });
  return NextResponse.json({ conversation: { id: conv.id, title: conv.title } }, { status: 201 });
});
