import { createHash } from 'node:crypto';
import { htmlToMarkdown, truncate } from '../../security/sanitize';
import { safeFetch } from '../../security/ssrf';
import { ToolError, type ToolFunction } from '../types';

const MAX_CHARS = 20_000;

/**
 * Escopo: HTML/texto acessível por HTTP simples. Páginas que dependem de JavaScript
 * ou bloqueiam robôs podem vir vazias ou falhar; não é um navegador completo.
 */
export const scrapePage: ToolFunction = {
  name: 'scrape_page',
  description:
    'Baixa uma página web pública (HTML/texto) e devolve o conteúdo principal em Markdown, com URL final e horário. ' +
    'Não executa JavaScript.',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', description: 'URL http(s) completa' } },
    required: ['url'],
    additionalProperties: false,
  },
  sideEffect: false,
  egress: 'open',
  privateData: false,
  timeoutMs: 20_000,
  async execute(args, ctx) {
    const res = await safeFetch(String(args.url), {
      timeoutMs: 15_000,
      maxBytes: 3_000_000,
      signal: ctx.signal,
      headers: { 'User-Agent': 'ChatTessBot/0.1 (+leitura sob demanda)', Accept: 'text/html,text/plain;q=0.9,*/*;q=0.1' },
    });
    if (res.status >= 400) throw new ToolError('http_status', `a página respondeu HTTP ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    const raw = res.body.toString('utf8');
    let title: string | null = null;
    let text: string;
    if (type.includes('html')) {
      const md = htmlToMarkdown(raw, res.url);
      title = md.title;
      text = md.markdown;
    } else if (type.startsWith('text/') || type.includes('json')) {
      text = raw;
    } else {
      throw new ToolError('unsupported_type', `tipo de conteúdo não suportado: ${type || 'desconhecido'}`);
    }
    if (!text.trim()) throw new ToolError('empty', 'nenhum conteúdo legível (a página pode depender de JavaScript)');
    const { text: body, truncated } = truncate(text, MAX_CHARS);
    const retrievedAt = new Date().toISOString();
    return {
      items: [
        {
          content: `URL final: ${res.url}\nObtido em: ${retrievedAt}${res.truncated || truncated ? '\n(conteúdo parcial)' : ''}\n\n${body}`,
          source: {
            kind: 'web',
            ref: res.url,
            url: res.url,
            title,
            excerpt: body.slice(0, 300),
            contentHash: createHash('sha256').update(raw).digest('hex'),
          },
        },
      ],
    };
  },
};
