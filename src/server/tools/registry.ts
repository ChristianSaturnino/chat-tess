import { and, eq } from 'drizzle-orm';
import { connections, conversationTools, conversations, mcpServers, tools, type ToolSnapshot } from '@/db/schema';
import { withTx, type Db } from '@/db/client';
import { audit } from '../audit/audit';
import { config } from '../config';
import { driveProvider, gmailProvider } from '../connectors/google/tools';
import { AppError, notFound } from '../errors';
import { scrapePage } from './builtin/scrape';
import { httpToolProvider } from './http-tools';
import { mcpProvider } from './mcp';
import type { ToolProvider } from './types';

export type AvailableTool = {
  key: string;
  label: string;
  kind: 'builtin' | 'google' | 'http' | 'mcp';
  version: string;
  available: boolean;
  unavailableReason?: string;
  defaultEnabled: boolean;
  enabled: boolean;
};

/** Catálogo de tools que o usuário pode habilitar nesta conversa, com o estado atual. */
export async function listConversationTools(d: Db, userId: string, conversationId: string): Promise<AvailableTool[]> {
  const [conv] = await d.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)));
  if (!conv) throw notFound('conversa');

  const overrides = new Map(
    (await d.select().from(conversationTools).where(eq(conversationTools.conversationId, conversationId))).map((r) => [r.toolKey, r.enabled]),
  );
  const conns = await d.select().from(connections).where(eq(connections.userId, userId));
  const httpTools = await d.select().from(tools).where(and(eq(tools.userId, userId), eq(tools.status, 'active')));
  const servers = (await d.select().from(mcpServers).where(eq(mcpServers.userId, userId))).filter((s) => s.status !== 'deleted');
  const webSearchOk = config().llm.provider === 'openai';

  const list: Omit<AvailableTool, 'enabled'>[] = [
    {
      key: 'builtin:web_search',
      label: 'Busca na web',
      kind: 'builtin',
      version: 'v1',
      available: webSearchOk,
      unavailableReason: webSearchOk ? undefined : 'busca nativa requer o provider OpenAI',
      defaultEnabled: true,
    },
    { key: 'builtin:scrape_page', label: 'Ler página web', kind: 'builtin', version: 'v1', available: true, defaultEnabled: true },
    ...(['drive', 'gmail'] as const).map((service) => {
      const c = conns.find((x) => x.service === service);
      return {
        key: `google:${service}`,
        label: service === 'drive' ? 'Google Drive' : 'Gmail',
        kind: 'google' as const,
        version: 'v1',
        available: c?.status === 'active',
        unavailableReason: !c || c.status === 'revoked' ? 'não conectado' : c.status === 'reconnect_required' ? 'reconexão necessária' : undefined,
        defaultEnabled: true,
      };
    }),
    ...httpTools.map((t) => ({ key: `http:${t.id}`, label: t.name, kind: 'http' as const, version: String(t.currentVersion), available: true, defaultEnabled: false })),
    ...servers.map((s) => ({
      key: `mcp:${s.id}`,
      label: s.name,
      kind: 'mcp' as const,
      version: String(s.catalogVersion),
      available: s.status === 'active' && s.catalog.length > 0,
      unavailableReason: s.status === 'error' ? (s.lastError ?? 'erro') : s.catalog.length === 0 ? 'nenhuma tool no catálogo' : undefined,
      defaultEnabled: false,
    })),
  ];
  return list.map((t) => ({ ...t, enabled: t.available && (overrides.get(t.key) ?? t.defaultEnabled) }));
}

export async function setConversationTool(userId: string, conversationId: string, toolKey: string, enabled: boolean) {
  return withTx(async ({ db: tx }) => {
    const available = await listConversationTools(tx, userId, conversationId);
    const t = available.find((x) => x.key === toolKey);
    if (!t) throw new AppError(404, 'tool_not_found', 'tool inexistente');
    if (enabled && !t.available) throw new AppError(409, 'tool_unavailable', t.unavailableReason ?? 'tool indisponível');
    await tx
      .insert(conversationTools)
      .values({ conversationId, toolKey, enabled })
      .onConflictDoUpdate({ target: [conversationTools.conversationId, conversationTools.toolKey], set: { enabled, updatedAt: new Date() } });
    await audit(tx, { actorUserId: userId, action: enabled ? 'tool.enable' : 'tool.disable', entityType: 'conversation', entityId: conversationId, payload: { toolKey } });
  });
}

/** Congela o conjunto habilitado (com versões) no início do run. */
export async function snapshotTools(d: Db, userId: string, conversationId: string): Promise<ToolSnapshot[]> {
  return (await listConversationTools(d, userId, conversationId)).filter((t) => t.enabled).map((t) => ({ key: t.key, version: t.version }));
}

export type RunToolset = {
  providers: ToolProvider[];
  webSearch: boolean;
  close(): Promise<void>;
};

/** Materializa os providers do snapshot. Tools que deixaram de existir simplesmente não são expostas. */
export async function resolveToolset(userId: string, snapshot: ToolSnapshot[]): Promise<RunToolset> {
  const providers: ToolProvider[] = [];
  const closers: (() => Promise<void>)[] = [];
  let webSearch = false;
  for (const s of snapshot) {
    const [kind, id] = s.key.split(':') as [string, string];
    if (s.key === 'builtin:web_search') webSearch = true;
    else if (s.key === 'builtin:scrape_page') {
      providers.push({ key: s.key, version: 'v1', label: 'Ler página web', functions: [scrapePage], stillAuthorized: async () => ({ ok: true }) });
    } else if (s.key === 'google:drive') providers.push(driveProvider(userId));
    else if (s.key === 'google:gmail') providers.push(gmailProvider(userId));
    else if (kind === 'http') {
      const p = await httpToolProvider(userId, id, Number(s.version));
      if (p) providers.push(p);
    } else if (kind === 'mcp') {
      const p = await mcpProvider(userId, id);
      if (p) {
        providers.push(p);
        closers.push(p.close);
      }
    }
  }
  return { providers, webSearch, close: async () => void (await Promise.all(closers.map((c) => c()))) };
}
