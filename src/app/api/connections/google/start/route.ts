import { randomBytes } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { buildConnectUrl } from '@/server/connectors/google/oauth';
import { config } from '@/server/config';
import { requireUser, route } from '@/server/http';

export const GET = route(async (req: NextRequest) => {
  await requireUser();
  const service = z.enum(['drive', 'gmail']).parse(req.nextUrl.searchParams.get('service'));
  const state = `${service}.${randomBytes(24).toString('base64url')}`;
  const { url, codeVerifier } = await buildConnectUrl(service, state);
  const res = NextResponse.redirect(url);
  const opts = { httpOnly: true, sameSite: 'lax' as const, secure: config().isProd, path: '/api/connections/google', maxAge: 600 };
  res.cookies.set('tess_conn_state', state, opts);
  res.cookies.set('tess_conn_verifier', codeVerifier, opts);
  return res;
});
