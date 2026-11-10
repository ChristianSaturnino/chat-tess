import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { upsertGoogleUser } from '@/server/auth/accounts';
import { exchangeLoginCode } from '@/server/auth/google';
import { SESSION_COOKIE } from '@/server/auth/session';
import { config } from '@/server/config';
import { AppError } from '@/server/errors';
import { route, sessionCookieOptions } from '@/server/http';

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const GET = route(async (req: NextRequest) => {
  const params = req.nextUrl.searchParams;
  const state = params.get('state') ?? '';
  const code = params.get('code');
  const expected = req.cookies.get('tess_oauth_state')?.value ?? '';
  const verifier = req.cookies.get('tess_oauth_verifier')?.value;
  if (params.get('error')) throw new AppError(400, 'google_denied', 'login cancelado no Google');
  if (!code || !verifier || !expected || !safeEqual(state, expected)) throw new AppError(400, 'bad_oauth_state', 'estado OAuth inválido');

  const profile = await exchangeLoginCode(code, verifier);
  const { session } = await upsertGoogleUser(profile);

  const res = NextResponse.redirect(new URL('/', config().env.APP_URL));
  res.cookies.set(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));
  res.cookies.delete({ name: 'tess_oauth_state', path: '/api/auth/google' });
  res.cookies.delete({ name: 'tess_oauth_verifier', path: '/api/auth/google' });
  return res;
});
