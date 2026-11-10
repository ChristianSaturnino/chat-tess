import { NextResponse, type NextRequest } from 'next/server';
import { deleteSession, SESSION_COOKIE } from '@/server/auth/session';
import { assertSameOrigin, route } from '@/server/http';

export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) await deleteSession(token);
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
});
