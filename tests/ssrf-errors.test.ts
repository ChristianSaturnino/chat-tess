import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, db } from '@/db/client';
import { mcpServers, tools } from '@/db/schema';
import { handleError } from '@/server/http';
import { SsrfBlockedError } from '@/server/security/ssrf';
import { createHttpTool } from '@/server/tools/http-tools';
import { createMcpServer } from '@/server/tools/mcp';
import { createTestUser, resetDb } from './helpers';

afterAll(closeDb);
beforeEach(resetDb);

async function body(res: Response) {
  return { status: res.status, ...((await res.json()) as { error: { code: string; reason?: string; message: string } }) };
}

describe('bloqueio de destino na API', () => {
  it('vira 400 com o motivo, também quando chega embrulhado pelo fetch', async () => {
    const direct = await body(handleError(new SsrfBlockedError('ip_nao_publico', '169.254.169.254')));
    expect(direct).toMatchObject({ status: 400, error: { code: 'destination_blocked', reason: 'ip_nao_publico' } });
    expect(direct.error.message).toContain('metadata');

    const wrapped = new TypeError('fetch failed', { cause: new SsrfBlockedError('dns_ip_nao_publico', 'interno.exemplo → 10.0.0.5') });
    expect(await body(handleError(wrapped))).toMatchObject({ status: 400, error: { reason: 'dns_ip_nao_publico' } });
  });

  it('cadastro de tool HTTP para endereço interno é recusado sem gravar nada', async () => {
    const user = await createTestUser();
    const attempt = createHttpTool(user.id, {
      name: 'metadata',
      description: 'tenta ler a metadata da nuvem',
      method: 'GET',
      url: 'https://169.254.169.254/latest/meta-data',
      parameters: { type: 'object', properties: {} },
    });
    const err = await attempt.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SsrfBlockedError);
    expect(await body(handleError(err))).toMatchObject({ status: 400, error: { reason: 'ip_nao_publico' } });
    expect(await db().select().from(tools).where(eq(tools.userId, user.id))).toHaveLength(0);
  });

  it('cadastro de servidor MCP em host interno é recusado com o motivo', async () => {
    const user = await createTestUser();
    const err = await createMcpServer(user.id, { name: 'interno', url: 'https://metadata.google.internal/mcp' }).catch((e: unknown) => e);
    expect(await body(handleError(err))).toMatchObject({ status: 400, error: { reason: 'host_interno' } });
    expect(await db().select().from(mcpServers).where(eq(mcpServers.userId, user.id))).toHaveLength(0);
  });
});
