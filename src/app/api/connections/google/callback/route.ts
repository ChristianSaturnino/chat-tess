import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { completeConnect, type GoogleService } from '@/server/connectors/google/oauth';
import { config } from '@/server/config';
import { AppError } from '@/server/errors';
import { requireUser, route } from '@/server/http';

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const GET = route(async (req: NextRequest) => {
  const user = await requireUser();
  const params = req.nextUrl.searchParams;
  const state = params.get('state') ?? '';
  const expected = req.cookies.get('tess_conn_state')?.value ?? '';
  const verifier = req.cookies.get('tess_conn_verifier')?.value;
  const code = params.get('code');
  const back = new URL('/?connectors=1', config().env.APP_URL);
  if (params.get('error')) {
    back.searchParams.set('connect_error', 'autorização cancelada');
    return NextResponse.redirect(back);
  }
  if (!code || !verifier || !expected || !safeEqual(state, expected)) throw new AppError(400, 'bad_oauth_state', 'estado OAuth inválido');
  const service = state.split('.')[0] as GoogleService;
  if (service !== 'drive' && service !== 'gmail') throw new AppError(400, 'bad_oauth_state', 'serviço inválido');

  try {
    await completeConnect(user.id, service, code, verifier);
  } catch (err) {
    back.searchParams.set('connect_error', err instanceof Error ? err.message : 'falha na conexão');
  }
  const res = NextResponse.redirect(back);
  res.cookies.delete({ name: 'tess_conn_state', path: '/api/connections/google' });
  res.cookies.delete({ name: 'tess_conn_verifier', path: '/api/connections/google' });
  return res;
});
