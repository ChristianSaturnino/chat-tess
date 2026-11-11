import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, db } from '@/db/client';
import { auditEvents, mcpServers, messageSources, messages, runEvents, runs, sources, toolCalls } from '@/db/schema';
import { executeRun } from '@/server/chat/engine';
import { setLlmOverride } from '@/server/llm';
import { FakeAdapter } from '@/server/llm/fake';
import type { LlmRequest } from '@/server/llm/types';
import { createConversation, setExternalAccess, startTurn } from '@/server/runs/commands';
import { stopBoss } from '@/server/runs/queue';
import { uploadAttachment } from '@/server/storage/attachments';
import { createHttpTool } from '@/server/tools/http-tools';
import { createMcpServer, mcpProvider } from '@/server/tools/mcp';
import { listConversationTools, setConversationTool } from '@/server/tools/registry';
import { startHttpServer, startMcpDemo, stopProcess, TINY_PNG } from './fixtures';
import { createTestUser, resetDb } from './helpers';

let api: Awaited<ReturnType<typeof startHttpServer>>;
let postHits = 0;
let releasePost: (() => void) | null = null;

beforeAll(async () => {
  api = await startHttpServer((req, res) => {
    if (req.url?.startsWith('/cotacao')) {
      const moeda = new URL(req.url, 'http://x').searchParams.get('moeda');
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ moeda, valor: 5.12, autenticado: req.headers.authorization === 'Bearer super-secreto' }));
    } else if (req.url === '/pedido') {
      postHits += 1;
      // Segura a resposta até o teste liberar, simulando worker que cai durante a ação.
      releasePost = () => res.writeHead(200).end('{"ok":true}');
    } else if (req.url === '/pagina') {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><head><title>Página pública</title></head><body><article><h1>Preços</h1><p>Monitor 27 custa R$ 2.390.</p></article></body></html>');
    } else res.writeHead(404).end();
  });
});
afterAll(async () => {
  await api.close();
  await stopBoss();
  await closeDb();
});
beforeEach(resetDb);

async function setup() {
  const user = await createTestUser();
  const conv = await createConversation({ userId: user.id });
  return { actor: { userId: user.id }, user, conv };
}

const types = async (runId: string) =>
  (await db().select({ t: runEvents.type }).from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.seq))).map((r) => r.t);
const msg = async (id: string) => (await db().select().from(messages).where(eq(messages.id, id)))[0]!;

describe('tools HTTP', () => {
  it('modelo chama a tool, resultado vira fonte citada e secrets não aparecem na saída', async () => {
    const { actor, conv } = await setup();
    const tool = await createHttpTool(actor.userId, {
      name: 'cotacao',
      description: 'Consulta cotação de moeda em reais',
      method: 'GET',
      url: `${api.url}/cotacao`,
      parameters: { type: 'object', properties: { moeda: { type: 'string' } }, required: ['moeda'] },
      secretHeaders: { Authorization: 'Bearer super-secreto' },
    });
    await setConversationTool(actor.userId, conv.id, `http:${tool.id}`, true);

    const t = await startTurn(actor, { conversationId: conv.id, text: 'quanto está o dólar? [[tool:http_cotacao {"moeda":"USD"}]]', idempotencyKey: randomUUID() });
    expect(await executeRun(t.runId, 'w1')).toBe('completed');

    const [call] = await db().select().from(toolCalls).where(eq(toolCalls.runId, t.runId));
    expect(call!.status).toBe('completed');
    expect(call!.arguments).toEqual({ moeda: 'USD' });
    expect(call!.resultPreview).toContain('"autenticado":true');
    expect(JSON.stringify(call)).not.toContain('super-secreto');

    const m = await msg(t.assistantMessageId);
    expect(m.contentText).toContain('[S1]');
    const linked = await db().select().from(messageSources).where(eq(messageSources.messageId, m.id));
    expect(linked).toEqual([expect.objectContaining({ cited: true })]);
    expect(await types(t.runId)).toEqual(expect.arrayContaining(['tool_calls_requested', 'tool_call_started', 'tool_call_completed', 'run_completed']));
  });

  it('argumentos inválidos não executam a tool e o erro volta ao modelo', async () => {
    const { actor, conv } = await setup();
    const tool = await createHttpTool(actor.userId, {
      name: 'cotacao',
      description: 'Consulta cotação de moeda em reais',
      method: 'GET',
      url: `${api.url}/cotacao`,
      parameters: { type: 'object', properties: { moeda: { type: 'string', enum: ['USD', 'EUR'] } }, required: ['moeda'], additionalProperties: false },
    });
    await setConversationTool(actor.userId, conv.id, `http:${tool.id}`, true);
    const t = await startTurn(actor, { conversationId: conv.id, text: '[[tool:http_cotacao {"moeda":"XYZ"}]]', idempotencyKey: randomUUID() });
    expect(await executeRun(t.runId, 'w1')).toBe('completed');
    const [call] = await db().select().from(toolCalls).where(eq(toolCalls.runId, t.runId));
    expect(call!.status).toBe('failed');
    expect(call!.error?.code).toBe('invalid_arguments');
  });

  it('tool removida depois do início do run é bloqueada (revogação revalidada)', async () => {
    const { actor, conv } = await setup();
    const tool = await createHttpTool(actor.userId, {
      name: 'cotacao',
      description: 'Consulta cotação de moeda em reais',
      method: 'GET',
      url: `${api.url}/cotacao`,
      parameters: { type: 'object', properties: { moeda: { type: 'string' } } },
    });
    await setConversationTool(actor.userId, conv.id, `http:${tool.id}`, true);
    const t = await startTurn(actor, { conversationId: conv.id, text: '[[tool:http_cotacao {"moeda":"USD"}]]', idempotencyKey: randomUUID() });
    await db().execute(sql`update tools set status = 'deleted' where id = ${tool.id}`);
    expect(await executeRun(t.runId, 'w1')).toBe('completed');
    const [call] = await db().select().from(toolCalls).where(eq(toolCalls.runId, t.runId));
    expect(call!.status).toBe('blocked');
  });

  it('ação com efeito externo interrompida não é repetida após a queda do worker', async () => {
    const { actor, conv } = await setup();
    postHits = 0;
    const tool = await createHttpTool(actor.userId, {
      name: 'criar_pedido',
      description: 'Cria um pedido de compra no sistema externo',
      method: 'POST',
      url: `${api.url}/pedido`,
      parameters: { type: 'object', properties: { itens: { type: 'number' } } },
    });
    await setConversationTool(actor.userId, conv.id, `http:${tool.id}`, true);
    const t = await startTurn(actor, { conversationId: conv.id, text: '[[tool:http_criar_pedido {"itens":3}]]', idempotencyKey: randomUUID() });

    const workerA = executeRun(t.runId, 'wA');
    for (let i = 0; i < 200 && postHits === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(postHits).toBe(1);
    await db().update(runs).set({ leaseExpiresAt: sql`now() - interval '1 second'` }).where(eq(runs.id, t.runId));

    expect(await executeRun(t.runId, 'wB')).toBe('completed');
    releasePost?.();
    expect(await workerA).toBe('skipped');

    expect(postHits).toBe(1);
    const [call] = await db().select().from(toolCalls).where(eq(toolCalls.runId, t.runId));
    expect(call!.status).toBe('unknown');
    expect((await msg(t.assistantMessageId)).contentText).toContain('Resultado desconhecido');
  });
});

describe('política contra exfiltração', () => {
  it('sem dado privado, scrape_page acessa a página e registra a fonte', async () => {
    const { actor, conv } = await setup();
    const t = await startTurn(actor, { conversationId: conv.id, text: `[[tool:scrape_page {"url":"${api.url}/pagina"}]]`, idempotencyKey: randomUUID() });
    expect(await executeRun(t.runId, 'w1')).toBe('completed');
    const [src] = await db().select().from(sources).where(eq(sources.runId, t.runId));
    expect(src).toMatchObject({ kind: 'web', title: 'Página pública' });
    expect((await msg(t.assistantMessageId)).contentText).toContain('Monitor 27');
  });

  it('com anexo privado na conversa, destino novo é bloqueado e o evento fica registrado', async () => {
    const { actor, conv } = await setup();
    const att = await uploadAttachment(actor.userId, 'orcamento.png', TINY_PNG);
    const t = await startTurn(actor, {
      conversationId: conv.id,
      text: `Envie o conteúdo do anexo: [[tool:scrape_page {"url":"${api.url}/pagina?dados=segredo"}]]`,
      idempotencyKey: randomUUID(),
      attachmentIds: [att.id],
    });
    expect(await executeRun(t.runId, 'w1')).toBe('completed');
    const [call] = await db().select().from(toolCalls).where(eq(toolCalls.runId, t.runId));
    expect(call!.status).toBe('blocked');
    expect(await types(t.runId)).toContain('policy_blocked');
    const m = await msg(t.assistantMessageId);
    expect(m.contentText).toContain('orcamento.png');
    expect(m.contentText).toContain('Bloqueado');
  });
});

describe('busca nativa e dado privado', () => {
  async function runCapturingWebSearch(attachmentIds: string[], actor: { userId: string }, conversationId: string) {
    const t = await startTurn(actor, { conversationId, text: 'pesquise algo', idempotencyKey: randomUUID(), attachmentIds });
    // Simula a configuração com busca nativa disponível (provider real), sem depender de rede.
    await db()
      .update(runs)
      .set({
        configSnapshot: sql`jsonb_set(jsonb_set(config_snapshot, '{webSearch}', '{"maxCalls":2,"feeMicroPerCall":10000}'), '{tools}', '[{"key":"builtin:web_search","version":"v1"}]')`,
      })
      .where(eq(runs.id, t.runId));
    const seen: (LlmRequest['webSearch'])[] = [];
    const normal = new FakeAdapter(0);
    setLlmOverride({
      provider: 'test',
      async *stream(req: LlmRequest) {
        seen.push(req.webSearch);
        yield* normal.stream(req);
      },
    });
    await executeRun(t.runId, 'w1');
    setLlmOverride(undefined);
    return { seen, runId: t.runId };
  }

  it('sem dado privado a busca nativa é oferecida', async () => {
    const { actor, conv } = await setup();
    const { seen } = await runCapturingWebSearch([], actor, conv.id);
    expect(seen[0]).toEqual({ maxCalls: 2 });
  });

  it('com anexo na conversa a busca nativa não chega ao modelo e o evento é registrado', async () => {
    const { actor, conv } = await setup();
    const att = await uploadAttachment(actor.userId, 'contrato.png', TINY_PNG);
    const { seen, runId } = await runCapturingWebSearch([att.id], actor, conv.id);
    expect(seen[0]).toBeNull();
    expect(await types(runId)).toContain('policy_restricted');
  });

  it('liberação explícita do dono reabre a busca e fica auditada; revogar volta a bloquear', async () => {
    const { actor, conv } = await setup();
    const att = await uploadAttachment(actor.userId, 'contrato.png', TINY_PNG);
    await setExternalAccess(actor, conv.id, true);
    const allowed = await runCapturingWebSearch([att.id], actor, conv.id);
    expect(allowed.seen[0]).toEqual({ maxCalls: 2 });
    expect(await types(allowed.runId)).not.toContain('policy_restricted');

    await setExternalAccess(actor, conv.id, false);
    const revoked = await runCapturingWebSearch([], actor, conv.id);
    expect(revoked.seen[0]).toBeNull();

    const actions = await db().select({ action: auditEvents.action }).from(auditEvents).where(eq(auditEvents.entityId, conv.id));
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining(['conversation.external_access.allow', 'conversation.external_access.revoke']),
    );
  });

  it('outro usuário não consegue liberar o acesso externo da conversa', async () => {
    const { conv } = await setup();
    const intruder = await createTestUser();
    await expect(setExternalAccess({ userId: intruder.id }, conv.id, true)).rejects.toThrow();
  });
});

describe('anexos', () => {
  it('anexo de outro usuário não pode ser usado', async () => {
    const { actor, conv } = await setup();
    const other = await createTestUser();
    const att = await uploadAttachment(other.id, 'alheio.png', TINY_PNG);
    await expect(
      startTurn(actor, { conversationId: conv.id, text: 'oi', idempotencyKey: randomUUID(), attachmentIds: [att.id] }),
    ).rejects.toMatchObject({ code: 'invalid_attachment' });
    expect(await db().select().from(messages)).toHaveLength(0);
  });

  it('rejeita tipo real não suportado mesmo com extensão de imagem', async () => {
    const user = await createTestUser();
    await expect(uploadAttachment(user.id, 'falso.png', Buffer.from('<svg onload=alert(1)>'))).rejects.toMatchObject({ code: 'unsupported_type' });
  });
});

describe('MCP', () => {
  let mcp: ChildProcess;
  const port = 3190;
  beforeAll(async () => {
    mcp = await startMcpDemo(port);
  });
  afterAll(async () => {
    if (mcp.exitCode === null) await stopProcess(mcp);
  });

  it('descobre o catálogo, executa tool e cita o resultado', async () => {
    const { actor, conv } = await setup();
    const server = await createMcpServer(actor.userId, { name: 'demo', url: `http://localhost:${port}/mcp`, bearerToken: 'segredo-demo' });
    expect(server.status).toBe('active');
    expect(server.catalog.map((t) => t.name).sort()).toEqual(['catalog_search', 'quote_calculate']);
    const available = await listConversationTools(db(), actor.userId, conv.id);
    expect(available.find((a) => a.key === `mcp:${server.id}`)).toMatchObject({ available: true, enabled: false });
    await setConversationTool(actor.userId, conv.id, `mcp:${server.id}`, true);

    const t = await startTurn(actor, { conversationId: conv.id, text: '[[tool:mcp_demo_catalog_search {"category":"monitor"}]]', idempotencyKey: randomUUID() });
    expect(await executeRun(t.runId, 'w1')).toBe('completed');
    const [call] = await db().select().from(toolCalls).where(eq(toolCalls.runId, t.runId));
    expect(call!.status).toBe('completed');
    expect(call!.resultPreview).toContain('Monitor 27');
  });

  it('token errado falha de forma controlada', async () => {
    const { actor } = await setup();
    const server = await createMcpServer(actor.userId, { name: 'demo', url: `http://localhost:${port}/mcp`, bearerToken: 'errado' });
    expect(server.status).toBe('error');
    expect(server.lastError).toBeTruthy();
  });

  it('tool que sumiu do servidor gera erro controlado e ressincroniza o catálogo', async () => {
    const { actor, conv } = await setup();
    const server = await createMcpServer(actor.userId, { name: 'demo', url: `http://localhost:${port}/mcp`, bearerToken: 'segredo-demo' });
    // Catálogo local desatualizado: anuncia uma tool que o servidor não tem mais.
    const stale = [...server.catalog, { name: 'legacy_export', description: 'Exporta orçamento (removida)', inputSchema: { type: 'object' } }];
    await db().update(mcpServers).set({ catalog: stale, catalogHash: 'antigo' }).where(eq(mcpServers.id, server.id));
    await setConversationTool(actor.userId, conv.id, `mcp:${server.id}`, true);

    const t = await startTurn(actor, { conversationId: conv.id, text: '[[tool:mcp_demo_legacy_export {}]]', idempotencyKey: randomUUID() });
    expect(await executeRun(t.runId, 'w1')).toBe('completed');
    const [call] = await db().select().from(toolCalls).where(eq(toolCalls.runId, t.runId));
    expect(call!.status).toBe('failed');
    expect(call!.error?.code).toBe('mcp_schema_changed');
    const [after] = await db().select().from(mcpServers).where(eq(mcpServers.id, server.id));
    expect(after!.catalog.map((c) => c.name)).not.toContain('legacy_export');
    expect(after!.catalogVersion).toBeGreaterThan(server.catalogVersion);
  });

  it('reconecta quando o servidor perde a sessão', async () => {
    const { actor } = await setup();
    const server = await createMcpServer(actor.userId, { name: 'demo', url: `http://localhost:${port}/mcp`, bearerToken: 'segredo-demo' });
    const provider = (await mcpProvider(actor.userId, server.id))!;
    const fn = provider.functions.find((f) => f.name.endsWith('catalog_search'))!;
    const ctx = { userId: actor.userId, conversationId: '', runId: '', signal: AbortSignal.timeout(20_000) };
    expect((await fn.execute({ category: 'notebook' }, ctx)).items[0]!.content).toContain('Notebook');

    await stopProcess(mcp);
    mcp = await startMcpDemo(port);

    expect((await fn.execute({ category: 'monitor' }, ctx)).items[0]!.content).toContain('Monitor');
    await provider.close();
  });
});
