import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { toolVersions, tools, type HttpToolConfig } from '@/db/schema';
import { db, withTx, type Db } from '@/db/client';
import { audit } from '../audit/audit';
import { AppError, notFound } from '../errors';
import { decrypt, encrypt } from '../security/crypto';
import { truncate } from '../security/sanitize';
import { assertUrlAllowed, safeFetch } from '../security/ssrf';
import { compileSchema, validateArgs } from './schema';
import { toFunctionName, ToolError, type ToolProvider } from './types';

const MAX_CHARS = 20_000;

export const httpToolInput = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{1,40}$/, 'use letras, números, _ ou -'),
  description: z.string().min(10).max(1000),
  method: z.enum(['GET', 'POST']),
  url: z.string().url(),
  parameters: z.record(z.string(), z.unknown()),
  secretHeaders: z.record(z.string(), z.string()).optional(),
  sideEffect: z.boolean().optional(),
});
export type HttpToolInput = z.infer<typeof httpToolInput>;

function buildConfig(input: HttpToolInput): HttpToolConfig {
  const url = assertUrlAllowed(input.url);
  if (url.protocol !== 'https:' && !process.env.SSRF_ALLOW_HOSTS?.includes(url.host)) {
    throw new AppError(400, 'https_required', 'tools HTTP exigem https');
  }
  if (input.parameters.type !== 'object') throw new AppError(400, 'invalid_schema', 'parameters deve ser um JSON Schema do tipo object');
  compileSchema(input.parameters);
  return {
    method: input.method,
    url: url.toString(),
    parameters: input.parameters,
    secretHeadersEnc: input.secretHeaders && Object.keys(input.secretHeaders).length ? encrypt(JSON.stringify(input.secretHeaders)) : null,
    // POST é tratado como ação com efeito externo salvo declaração contrária do dono.
    sideEffect: input.sideEffect ?? input.method === 'POST',
  };
}

export async function createHttpTool(userId: string, input: HttpToolInput) {
  const config = buildConfig(input);
  return withTx(async ({ db: tx }) => {
    const [tool] = await tx.insert(tools).values({ userId, name: input.name, description: input.description }).returning();
    await tx.insert(toolVersions).values({ toolId: tool!.id, version: 1, config });
    await audit(tx, {
      actorUserId: userId,
      action: 'tool.create',
      entityType: 'tool',
      entityId: tool!.id,
      payload: { name: input.name, method: config.method, url: config.url, hasSecrets: !!config.secretHeadersEnc },
    });
    return tool!;
  });
}

export async function listHttpTools(userId: string) {
  const rows = await db()
    .select({ id: tools.id, name: tools.name, description: tools.description, version: tools.currentVersion, config: toolVersions.config })
    .from(tools)
    .innerJoin(toolVersions, and(eq(toolVersions.toolId, tools.id), eq(toolVersions.version, tools.currentVersion)))
    .where(and(eq(tools.userId, userId), eq(tools.status, 'active')));
  return rows.map(({ config, ...r }) => ({
    ...r,
    method: config.method,
    url: config.url,
    parameters: config.parameters,
    sideEffect: config.sideEffect,
    hasSecrets: !!config.secretHeadersEnc,
  }));
}

export async function deleteHttpTool(userId: string, toolId: string) {
  await withTx(async ({ db: tx }) => {
    const r = await tx
      .update(tools)
      .set({ status: 'deleted' })
      .where(and(eq(tools.id, toolId), eq(tools.userId, userId), eq(tools.status, 'active')))
      .returning({ id: tools.id });
    if (!r.length) throw notFound('tool');
    await audit(tx, { actorUserId: userId, action: 'tool.delete', entityType: 'tool', entityId: toolId });
  });
}

async function loadVersion(d: Db, toolId: string, version: number) {
  const [row] = await d
    .select({ tool: tools, config: toolVersions.config })
    .from(tools)
    .innerJoin(toolVersions, and(eq(toolVersions.toolId, tools.id), eq(toolVersions.version, version)))
    .where(eq(tools.id, toolId));
  return row ?? null;
}

export async function executeHttpTool(config: HttpToolConfig, args: Record<string, unknown>, signal?: AbortSignal) {
  const headers: Record<string, string> = { Accept: 'application/json, text/plain;q=0.9' };
  const secret = config.secretHeadersEnc ? (JSON.parse(decrypt(config.secretHeadersEnc)) as Record<string, string>) : {};
  Object.assign(headers, secret);
  let url = config.url;
  let body: string | undefined;
  if (config.method === 'GET') {
    const u = new URL(config.url);
    for (const [k, v] of Object.entries(args)) u.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    url = u.toString();
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(args);
  }
  const res = await safeFetch(url, {
    method: config.method,
    headers,
    body,
    timeoutMs: 20_000,
    maxBytes: 500_000,
    // Secrets nunca seguem redirect para outra origem.
    sensitiveHeaders: [...Object.keys(secret), 'authorization', 'cookie'],
    signal,
  });
  const text = res.body.toString('utf8');
  return { status: res.status, text, finalUrl: res.url, truncated: res.truncated };
}

/** Provider de uma tool HTTP numa versão congelada pelo run. */
export async function httpToolProvider(userId: string, toolId: string, version: number): Promise<ToolProvider | null> {
  const row = await loadVersion(db(), toolId, version);
  if (!row || row.tool.userId !== userId) return null;
  const { tool, config } = row;
  return {
    key: `http:${toolId}`,
    version: String(version),
    label: tool.name,
    async stillAuthorized() {
      const [t] = await db().select({ status: tools.status }).from(tools).where(eq(tools.id, toolId));
      return t?.status === 'active' ? { ok: true } : { ok: false, code: 'tool_removed', message: 'a tool foi removida pelo dono' };
    },
    functions: [
      {
        name: toFunctionName('http', tool.name),
        description: tool.description,
        parameters: config.parameters,
        sideEffect: config.sideEffect,
        egress: 'reviewed',
        privateData: false,
        timeoutMs: 25_000,
        async execute(args, ctx) {
          validateArgs(config.parameters, args);
          const r = await executeHttpTool(config, args, ctx.signal);
          if (r.status >= 400) throw new ToolError('http_status', `a API respondeu HTTP ${r.status}: ${r.text.slice(0, 300)}`);
          const { text } = truncate(r.text, MAX_CHARS);
          return {
            items: [
              {
                content: text,
                source: {
                  kind: 'http',
                  ref: `${tool.name}:${createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 16)}`,
                  url: null,
                  title: `${tool.name} (${config.method} ${new URL(config.url).host})`,
                  excerpt: text.slice(0, 300),
                },
              },
            ],
          };
        },
      },
    ],
  };
}
