import { NextResponse } from 'next/server';
import { z } from 'zod';
import { globalAccount, listUsersWithCredits, requireAdmin, setLimit } from '@/server/admin/admin';
import { assertSameOrigin, requireUser, route } from '@/server/http';

export const GET = route(async () => {
  const user = await requireUser();
  requireAdmin(user);
  return NextResponse.json({ global: await globalAccount(), users: await listUsersWithCredits() });
});

const body = z.object({
  target: z.union([z.object({ userId: z.uuid() }), z.object({ global: z.literal(true) })]),
  limitMicro: z.number().int().nonnegative(),
  reason: z.string().min(3).max(300),
});

export const PUT = route(async (req: Request) => {
  assertSameOrigin(req);
  const user = await requireUser();
  requireAdmin(user);
  const b = body.parse(await req.json());
  return NextResponse.json({ account: await setLimit(user, b.target, b.limitMicro, b.reason) });
});
