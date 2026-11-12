import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { mcpServers, type McpToolDef } from '@/db/schema';
import { db, withTx } from '@/db/client';
import { audit } from '../audit/audit';
import { AppError, notFound } from '../errors';
import { logger } from '../logger';
import { decrypt, encrypt } from '../security/crypto';
import { truncate } from '../security/sanitize';
import { assertUrlAllowed, findSsrfError, guardedFetchLike } from '../security/ssrf';
import { validateArgs } from './schema';
import { toFunctionName, ToolError, type ToolProvider } from './types';

const MAX_CHARS = 20_000;
const MAX_TOOLS = 50;
const CALL_TIMEOUT_MS = 30_000;

export const mcpServerInput = z.object({
  name: z.string().trim().min(2).max(40),
  url: z.string().trim().url(),
  bearerToken: z.string().trim().min(1).max(4000).optional(),
});

type ServerRow = typeof mcpServers.$inferSelect;

async function connect(server: Pick<ServerRow, 'url' | 'bearerTokenEnc'>) {
  const url = assertUrlAllowed(server.url);
  const headers: Record<string, string> = {};
  if (server.bearerTokenEnc) headers.Authorization = `Bearer ${decrypt(server.bearerTokenEnc)}`;
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers }, fetch: guardedFetchLike() });
  const client = new Client({ name: 'chat-tess', version: '0.1.0' });
  await client.connect(transport, { timeout: 15_000 });
  return { client, transport };
}

/** Discovery paginado. Catálogo muda de versão somente quando o conteúdo muda (hash). */
async function discover(server: Pick<ServerRow, 'url' | 'bearerTokenEnc'>): Promise<McpToolDef[]> {
  const { client } = await connect(server);
  try {
    const out: McpToolDef[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 15_000 });
      for (const t of page.tools) {
        out.push({
          name: t.name,
          description: (t.description ?? t.title ?? t.name).slice(0, 1000),
          inputSchema: t.inputSchema as Record<string, unknown>,
          readOnlyHint: t.annotations?.readOnlyHint,
        });
      }
      cursor = page.nextCursor;
    } while (cursor && out.length < MAX_TOOLS);
    return out.slice(0, MAX_TOOLS);
  } finally {
    await client.close().catch(() => {});
  }
}

const catalogHash = (c: McpToolDef[]) => createHash('sha256').update(JSON.stringify(c)).digest('hex');

export async function syncMcpServer(userId: string, serverId: string) {
  const [server] = await db().select().from(mcpServers).where(and(eq(mcpServers.id, serverId), eq(mcpServers.userId, userId)));
  if (!server || server.status === 'deleted') throw notFound('servidor MCP');
  try {
    const catalog = await discover(server);
    const hash = catalogHash(catalog);
    return await withTx(async ({ db: tx }) => {
      const changed = hash !== server.catalogHash;
      const [row] = await tx
        .update(mcpServers)
        .set({
          catalog,
          catalogHash: hash,
          catalogVersion: changed ? server.catalogVersion + 1 : server.catalogVersion,
          status: 'active',
          lastError: null,
          lastSyncedAt: new Date(),
        })
        .where(eq(mcpServers.id, serverId))
        .returning();
      await audit(tx, { actorUserId: userId, action: 'mcp.sync', entityType: 'mcp_server', entityId: serverId, payload: { tools: catalog.length, changed } });
      return row!;
    });
  } catch (err) {
    const message = findSsrfError(err)?.message ?? (err instanceof Error ? err.message : String(err));
    await db().update(mcpServers).set({ status: 'error', lastError: message.slice(0, 500) }).where(eq(mcpServers.id, serverId));
    throw new AppError(502, 'mcp_sync_failed', `não foi possível listar as tools: ${message}`);
  }
}

export async function createMcpServer(userId: string, input: z.infer<typeof mcpServerInput>) {
  assertUrlAllowed(input.url);
  const [server] = await withTx(async ({ db: tx }) => {
    const rows = await tx
      .insert(mcpServers)
      .values({ userId, name: input.name, url: input.url, bearerTokenEnc: input.bearerToken ? encrypt(input.bearerToken) : null })
      .returning();
    await audit(tx, { actorUserId: userId, action: 'mcp.create', entityType: 'mcp_server', entityId: rows[0]!.id, payload: { url: input.url } });
    return rows;
  });
  try {
    return await syncMcpServer(userId, server!.id);
  } catch {
    // Cadastro mantido com status de erro; o usuário corrige e ressincroniza.
    const [row] = await db().select().from(mcpServers).where(eq(mcpServers.id, server!.id));
    return row!;
  }
}

export async function listMcpServers(userId: string) {
  const rows = await db().select().from(mcpServers).where(eq(mcpServers.userId, userId));
  return rows
    .filter((s) => s.status !== 'deleted')
    .map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      status: s.status,
      lastError: s.lastError,
      catalogVersion: s.catalogVersion,
      tools: s.catalog.map((t) => ({ name: t.name, description: t.description })),
      hasToken: !!s.bearerTokenEnc,
      lastSyncedAt: s.lastSyncedAt,
    }));
}

export async function deleteMcpServer(userId: string, serverId: string) {
  await withTx(async ({ db: tx }) => {
    const r = await tx
      .update(mcpServers)
      .set({ status: 'deleted', bearerTokenEnc: null })
      .where(and(eq(mcpServers.id, serverId), eq(mcpServers.userId, userId)))
      .returning({ id: mcpServers.id });
    if (!r.length) throw notFound('servidor MCP');
    await audit(tx, { actorUserId: userId, action: 'mcp.delete', entityType: 'mcp_server', entityId: serverId });
  });
}

const isSessionError = (err: unknown) => err instanceof StreamableHTTPError && (err.code === 404 || err.code === 400);

/**
 * Provider de um servidor MCP para um run. Uma sessão por run, reaberta uma vez se o servidor
 * invalidar a sessão. Tool ausente do catálogo atual dispara ressincronização e erro controlado.
 */
export async function mcpProvider(userId: string, serverId: string): Promise<(ToolProvider & { close(): Promise<void> }) | null> {
  const [server] = await db().select().from(mcpServers).where(and(eq(mcpServers.id, serverId), eq(mcpServers.userId, userId)));
  if (!server || server.status === 'deleted') return null;

  let session: Awaited<ReturnType<typeof connect>> | null = null;
  const getSession = async (fresh = false) => {
    if (fresh && session) {
      await session.client.close().catch(() => {});
      session = null;
    }
    session ??= await connect(server);
    return session;
  };

  const callTool = async (name: string, args: Record<string, unknown>, signal: AbortSignal) => {
    const run = async (fresh: boolean) =>
      (await getSession(fresh)).client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS, signal });
    try {
      return await run(false);
    } catch (err) {
      if (!isSessionError(err)) throw err;
      logger.warn({ serverId }, 'sessão MCP inválida; reconectando');
      return await run(true);
    }
  };

  return {
    key: `mcp:${serverId}`,
    version: String(server.catalogVersion),
    label: server.name,
    async close() {
      await session?.client.close().catch(() => {});
    },
    async stillAuthorized() {
      const [s] = await db().select({ status: mcpServers.status }).from(mcpServers).where(eq(mcpServers.id, serverId));
      return s && s.status !== 'deleted' ? { ok: true } : { ok: false, code: 'mcp_removed', message: 'servidor MCP removido' };
    },
    functions: server.catalog.map((def) => ({
      name: toFunctionName('mcp', server.name, def.name),
      description: `[MCP ${server.name}] ${def.description}`,
      parameters: def.inputSchema,
      // readOnlyHint é declarado pelo servidor; não substitui a política, só evita repetir ações.
      sideEffect: def.readOnlyHint !== true,
      egress: 'reviewed' as const,
      privateData: false,
      timeoutMs: CALL_TIMEOUT_MS + 5_000,
      async execute(args, ctx) {
        validateArgs(def.inputSchema, args);
        // Servidores sinalizam tool inexistente ou argumentos fora do schema lançando erro
        // ou devolvendo isError com a mensagem; os dois casos disparam ressincronização.
        const schemaChanged = async () => {
          await syncMcpServer(userId, serverId).catch(() => {});
          return new ToolError('mcp_schema_changed', `a tool ${def.name} mudou ou não existe mais no servidor; catálogo ressincronizado`);
        };
        const looksLikeSchemaChange = (msg: string) => /tool .*not found|unknown tool|-32602/i.test(msg);
        let result;
        try {
          result = await callTool(def.name, args, ctx.signal);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (looksLikeSchemaChange(msg)) throw await schemaChanged();
          throw new ToolError('mcp_error', msg);
        }
        const parts = (result.content as { type: string; text?: string }[] | undefined) ?? [];
        const text = parts.map((p) => (p.type === 'text' ? p.text : `[conteúdo ${p.type} omitido]`)).join('\n');
        if (result.isError === true && looksLikeSchemaChange(text)) throw await schemaChanged();
        const { text: body } = truncate(text || JSON.stringify(result.structuredContent ?? {}), MAX_CHARS);
        return {
          isError: result.isError === true,
          items: [
            {
              content: body,
              source: {
                kind: 'mcp',
                ref: `${server.name}/${def.name}:${createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 16)}`,
                url: null,
                title: `${server.name} · ${def.name}`,
                excerpt: body.slice(0, 300),
              },
            },
          ],
        };
      },
    })),
  };
}
