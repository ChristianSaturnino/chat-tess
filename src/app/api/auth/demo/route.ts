import { NextResponse } from 'next/server';
import { createDemoUser } from '@/server/auth/accounts';
import { SESSION_COOKIE } from '@/server/auth/session';
import { assertSameOrigin, route, sessionCookieOptions } from '@/server/http';

export const POST = route(async (req: Request) => {
  assertSameOrigin(req);
  const { user, session } = await createDemoUser();
  const res = NextResponse.json({ userId: user.id });
  res.cookies.set(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));
  return res;
});
