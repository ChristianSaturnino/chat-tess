import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { buildLoginUrl } from '@/server/auth/google';
import { config } from '@/server/config';
import { route } from '@/server/http';

export const GET = route(async () => {
  const state = randomBytes(24).toString('base64url');
  const { url, codeVerifier } = await buildLoginUrl(state);
  const res = NextResponse.redirect(url);
  const opts = { httpOnly: true, sameSite: 'lax' as const, secure: config().isProd, path: '/api/auth/google', maxAge: 600 };
  res.cookies.set('tess_oauth_state', state, opts);
  res.cookies.set('tess_oauth_verifier', codeVerifier, opts);
  return res;
});
