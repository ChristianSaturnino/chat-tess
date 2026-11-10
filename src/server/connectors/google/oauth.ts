import { and, eq, sql } from 'drizzle-orm';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { connections } from '@/db/schema';
import { db, withTx } from '@/db/client';
import { audit } from '../../audit/audit';
import { config } from '../../config';
import { AppError, notFound } from '../../errors';
import { logger } from '../../logger';
import { decrypt, encrypt } from '../../security/crypto';

export type GoogleService = 'drive' | 'gmail';

/** Scopes mínimos por serviço. Ambos são restritos: o app precisa estar em Testing com test users. */
export const SERVICE_SCOPES: Record<GoogleService, string> = {
  drive: 'https://www.googleapis.com/auth/drive.readonly',
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
};

export class ReconnectRequiredError extends Error {
  constructor(readonly service: GoogleService) {
    super(`conexão ${service} precisa ser refeita`);
  }
}

function oauthClient() {
  const { env } = config();
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new AppError(503, 'google_not_configured', 'OAuth Google não configurado');
  return new OAuth2Client({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: `${env.APP_URL}/api/connections/google/callback`,
  });
}

export async function buildConnectUrl(service: GoogleService, state: string) {
  const client = oauthClient();
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const url = client.generateAuthUrl({
    access_type: 'offline',
    // consent garante refresh_token; include_granted_scopes torna a autorização incremental.
    prompt: 'consent',
    include_granted_scopes: true,
    scope: ['openid', 'email', SERVICE_SCOPES[service]],
    state,
    code_challenge: codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
  });
  return { url, codeVerifier };
}

export async function completeConnect(userId: string, service: GoogleService, code: string, codeVerifier: string) {
  const client = oauthClient();
  const { tokens } = await client.getToken({ code, codeVerifier });
  const granted = (tokens.scope ?? '').split(' ').filter(Boolean);
  if (!granted.includes(SERVICE_SCOPES[service])) {
    throw new AppError(403, 'scope_not_granted', 'a permissão solicitada não foi concedida');
  }
  if (!tokens.id_token) throw new AppError(400, 'google_no_id_token', 'resposta do Google sem id_token');
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: config().env.GOOGLE_CLIENT_ID! });
  const p = ticket.getPayload()!;

  await withTx(async ({ db: tx }) => {
    const [existing] = await tx
      .select()
      .from(connections)
      .where(and(eq(connections.userId, userId), eq(connections.provider, 'google'), eq(connections.service, service)))
      .for('update');
    const values = {
      externalAccountId: p.sub,
      externalEmail: p.email ?? null,
      grantedScopes: granted,
      accessTokenEnc: tokens.access_token ? encrypt(tokens.access_token) : null,
      // Sem refresh_token novo, preserva o anterior.
      refreshTokenEnc: tokens.refresh_token ? encrypt(tokens.refresh_token) : (existing?.refreshTokenEnc ?? null),
      accessTokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      status: 'active' as const,
      lastError: null,
      updatedAt: new Date(),
    };
    if (existing) await tx.update(connections).set(values).where(eq(connections.id, existing.id));
    else await tx.insert(connections).values({ userId, provider: 'google', service, ...values });
    await audit(tx, {
      actorUserId: userId,
      action: 'connection.connect',
      entityType: 'connection',
      entityId: `google:${service}`,
      payload: { service, scopes: granted, externalEmail: p.email ?? null },
    });
  });
}

export async function listConnections(userId: string) {
  const rows = await db().select().from(connections).where(eq(connections.userId, userId));
  return rows.map((c) => ({
    id: c.id,
    provider: c.provider,
    service: c.service,
    status: c.status,
    externalEmail: c.externalEmail,
    grantedScopes: c.grantedScopes,
    lastError: c.lastError,
  }));
}

export async function disconnect(userId: string, connectionId: string) {
  const token = await withTx(async ({ db: tx }) => {
    const [c] = await tx
      .select()
      .from(connections)
      .where(and(eq(connections.id, connectionId), eq(connections.userId, userId)))
      .for('update');
    if (!c) throw notFound('conexão');
    await tx
      .update(connections)
      .set({ status: 'revoked', accessTokenEnc: null, refreshTokenEnc: null, updatedAt: new Date() })
      .where(eq(connections.id, c.id));
    await audit(tx, { actorUserId: userId, action: 'connection.revoke', entityType: 'connection', entityId: c.id, payload: { service: c.service } });
    return c.refreshTokenEnc ? decrypt(c.refreshTokenEnc) : null;
  });
  if (token) await oauthClient().revokeToken(token).catch((err) => logger.warn({ err }, 'revogação no Google falhou'));
}

/**
 * Access token válido para a conexão do próprio usuário. Refresh serializado por conexão
 * (FOR UPDATE): requisições concorrentes esperam e reaproveitam o token renovado.
 */
export async function getAccessToken(userId: string, service: GoogleService): Promise<string> {
  return withTx(async ({ db: tx }) => {
    const [c] = await tx
      .select()
      .from(connections)
      .where(and(eq(connections.userId, userId), eq(connections.provider, 'google'), eq(connections.service, service)))
      .for('update');
    if (!c || c.status !== 'active') throw new ReconnectRequiredError(service);
    const fresh = c.accessTokenEnc && c.accessTokenExpiresAt && c.accessTokenExpiresAt.getTime() - Date.now() > 60_000;
    if (fresh) return decrypt(c.accessTokenEnc!);
    if (!c.refreshTokenEnc) {
      await tx.update(connections).set({ status: 'reconnect_required', lastError: 'sem refresh token' }).where(eq(connections.id, c.id));
      throw new ReconnectRequiredError(service);
    }
    const client = oauthClient();
    client.setCredentials({ refresh_token: decrypt(c.refreshTokenEnc) });
    try {
      const { credentials } = await client.refreshAccessToken();
      await tx
        .update(connections)
        .set({
          accessTokenEnc: encrypt(credentials.access_token!),
          refreshTokenEnc: credentials.refresh_token ? encrypt(credentials.refresh_token) : c.refreshTokenEnc,
          accessTokenExpiresAt: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
          updatedAt: sql`now()`,
        })
        .where(eq(connections.id, c.id));
      return credentials.access_token!;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // invalid_grant: revogado pelo usuário ou expirado (apps em Testing expiram em 7 dias).
      if (/invalid_grant|unauthorized_client/i.test(message)) {
        await tx.update(connections).set({ status: 'reconnect_required', lastError: message.slice(0, 300) }).where(eq(connections.id, c.id));
        throw new ReconnectRequiredError(service);
      }
      throw err;
    }
  });
}

export async function connectionActive(userId: string, service: GoogleService) {
  const [c] = await db()
    .select({ status: connections.status })
    .from(connections)
    .where(and(eq(connections.userId, userId), eq(connections.provider, 'google'), eq(connections.service, service)));
  return c?.status === 'active';
}
