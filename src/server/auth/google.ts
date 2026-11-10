import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { config } from '../config';
import { AppError } from '../errors';

/**
 * Login Google somente para identidade (openid email profile).
 * Autorização de Drive/Gmail é uma conexão separada, com OAuth incremental próprio.
 */
export function googleLoginClient() {
  const { env } = config();
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new AppError(503, 'google_not_configured', 'login Google não configurado');
  }
  return new OAuth2Client({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: `${env.APP_URL}/api/auth/google/callback`,
  });
}

export async function buildLoginUrl(state: string) {
  const client = googleLoginClient();
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const url = client.generateAuthUrl({
    scope: ['openid', 'email', 'profile'],
    state,
    code_challenge: codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
    prompt: 'select_account',
  });
  return { url, codeVerifier };
}

export async function exchangeLoginCode(code: string, codeVerifier: string) {
  const client = googleLoginClient();
  const { tokens } = await client.getToken({ code, codeVerifier });
  if (!tokens.id_token) throw new AppError(400, 'google_no_id_token', 'resposta do Google sem id_token');
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: config().env.GOOGLE_CLIENT_ID! });
  const p = ticket.getPayload();
  if (!p?.sub) throw new AppError(400, 'google_invalid_token', 'id_token inválido');
  if (p.email && p.email_verified === false) throw new AppError(403, 'google_email_unverified', 'e-mail Google não verificado');
  return { sub: p.sub, email: p.email ?? null, name: p.name ?? null };
}
