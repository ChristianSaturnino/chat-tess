import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

/**
 * Servidor MCP de demonstração: catálogo sintético de equipamentos e cálculo de orçamento.
 * Streamable HTTP com sessões; bearer token opcional (MCP_DEMO_TOKEN).
 */

const CATALOG = [
  { sku: 'NB-14-PRO', name: 'Notebook 14" Pro', category: 'notebook', priceBrl: 7890, specs: '16 GB RAM, 512 GB SSD, tela 14" 2.8K' },
  { sku: 'NB-15-STD', name: 'Notebook 15" Standard', category: 'notebook', priceBrl: 4590, specs: '8 GB RAM, 256 GB SSD, tela 15.6" FHD' },
  { sku: 'MN-27-4K', name: 'Monitor 27" 4K', category: 'monitor', priceBrl: 2390, specs: 'IPS, 60 Hz, USB-C 65 W' },
  { sku: 'MN-24-FHD', name: 'Monitor 24" Full HD', category: 'monitor', priceBrl: 899, specs: 'IPS, 75 Hz, HDMI' },
  { sku: 'DK-USB-C', name: 'Dock USB-C', category: 'acessorio', priceBrl: 649, specs: '2x HDMI, 4x USB, rede gigabit, 100 W' },
  { sku: 'HS-BT-NC', name: 'Headset Bluetooth com cancelamento de ruído', category: 'acessorio', priceBrl: 1190, specs: 'ANC, 30 h de bateria' },
];

function buildServer() {
  const server = new McpServer({ name: 'tess-demo-catalogo', version: '1.0.0' });

  server.registerTool(
    'catalog_search',
    {
      description: 'Busca itens no catálogo sintético de equipamentos por texto e/ou categoria (notebook, monitor, acessorio).',
      inputSchema: { query: z.string().optional(), category: z.enum(['notebook', 'monitor', 'acessorio']).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ query, category }) => {
      const q = query?.toLowerCase() ?? '';
      const items = CATALOG.filter((i) => (!category || i.category === category) && (!q || `${i.name} ${i.specs} ${i.sku}`.toLowerCase().includes(q)));
      const text = items.length
        ? items.map((i) => `${i.sku} | ${i.name} | R$ ${i.priceBrl.toFixed(2)} | ${i.specs}`).join('\n')
        : 'Nenhum item encontrado.';
      return { content: [{ type: 'text', text: `Catálogo sintético (dados de demonstração):\n${text}` }] };
    },
  );

  server.registerTool(
    'quote_calculate',
    {
      description: 'Calcula o total de um orçamento a partir de SKUs e quantidades, com desconto percentual e frete opcionais.',
      inputSchema: {
        items: z.array(z.object({ sku: z.string(), quantity: z.number().int().positive() })).min(1),
        discountPercent: z.number().min(0).max(50).optional(),
        shippingBrl: z.number().min(0).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ items, discountPercent = 0, shippingBrl = 0 }) => {
      const lines: string[] = [];
      let subtotal = 0;
      for (const it of items) {
        const p = CATALOG.find((c) => c.sku === it.sku);
        if (!p) return { isError: true, content: [{ type: 'text', text: `SKU desconhecido: ${it.sku}` }] };
        const total = p.priceBrl * it.quantity;
        subtotal += total;
        lines.push(`${it.quantity}x ${p.name} (${p.sku}) = R$ ${total.toFixed(2)}`);
      }
      const discount = (subtotal * discountPercent) / 100;
      const total = subtotal - discount + shippingBrl;
      lines.push(`Subtotal: R$ ${subtotal.toFixed(2)}`, `Desconto (${discountPercent}%): -R$ ${discount.toFixed(2)}`, `Frete: R$ ${shippingBrl.toFixed(2)}`, `Total: R$ ${total.toFixed(2)}`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
  return server;
}

const transports = new Map<string, StreamableHTTPServerTransport>();
const token = process.env.MCP_DEMO_TOKEN;

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

function send(res: ServerResponse, status: number, body: object) {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

const http = createServer(async (req, res) => {
  try {
    if (!req.url?.startsWith('/mcp')) return send(res, 404, { error: 'not found' });
    if (token && req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: 'unauthorized' });

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const body = req.method === 'POST' ? await readJson(req) : undefined;
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      if (sessionId) return send(res, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'sessão não encontrada' }, id: null });
      if (req.method !== 'POST' || !isInitializeRequest(body)) {
        return send(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'inicialização necessária' }, id: null });
      }
      const created = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => void transports.set(id, created),
      });
      created.onclose = () => {
        if (created.sessionId) transports.delete(created.sessionId);
      };
      await buildServer().connect(created);
      transport = created;
    }
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'internal' });
  }
});

if (process.env.NODE_ENV === 'production' && !token) {
  console.error('MCP_DEMO_TOKEN é obrigatório em produção');
  process.exit(1);
}

// Em plataformas como o Railway a porta pública chega em PORT.
const port = Number(process.env.MCP_DEMO_PORT ?? process.env.PORT ?? 3100);
http.listen(port, () => console.log(`MCP demo em http://localhost:${port}/mcp${token ? ' (bearer token exigido)' : ''}`));
