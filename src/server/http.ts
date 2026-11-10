import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { InsufficientCreditsError } from './credits/credits';
import { config } from './config';
import { AppError, unauthorized } from './errors';
import { logger } from './logger';
import { SESSION_COOKIE, userFromSessionToken, type SessionUser } from './auth/session';

export async function currentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  return userFromSessionToken(jar.get(SESSION_COOKIE)?.value);
}

export async function requireUser(): Promise<SessionUser> {
  const u = await currentUser();
  if (!u) throw unauthorized();
  return u;
}

/** Proteção CSRF para mutações: Origin precisa coincidir com a aplicação. */
export function assertSameOrigin(req: Request) {
  const origin = req.headers.get('origin');
  const expected = new URL(config().env.APP_URL).origin;
  const self = new URL(req.url).origin;
  if (!origin || (origin !== expected && origin !== self)) {
    throw new AppError(403, 'bad_origin', 'origem não permitida');
  }
}

export function sessionCookieOptions(expires: Date) {
  return { httpOnly: true, sameSite: 'lax' as const, secure: config().isProd, path: '/', expires };
}

export function handleError(err: unknown) {
  if (err instanceof AppError) {
    return NextResponse.json({ error: { code: err.code, message: err.message, ...err.details } }, { status: err.status });
  }
  if (err instanceof ZodError) {
    return NextResponse.json({ error: { code: 'invalid_payload', message: 'payload inválido', issues: err.issues } }, { status: 400 });
  }
  if (err instanceof SyntaxError) {
    return NextResponse.json({ error: { code: 'invalid_json', message: 'corpo JSON inválido' } }, { status: 400 });
  }
  if (err instanceof InsufficientCreditsError) {
    return NextResponse.json({ error: { code: 'insufficient_credits', message: err.message } }, { status: 402 });
  }
  logger.error({ err }, 'erro não tratado na API');
  return NextResponse.json({ error: { code: 'internal', message: 'erro interno' } }, { status: 500 });
}

export function route<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      return handleError(err);
    }
  };
}
