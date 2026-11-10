import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
// Imagens remotas não são carregadas nem repassadas: viram apenas o texto alternativo.
turndown.addRule('noImages', { filter: 'img', replacement: (_c, node) => ((node as HTMLElement).getAttribute('alt') ?? '').trim() });
turndown.remove(['script', 'style', 'noscript', 'iframe', 'object', 'embed', 'form']);

/** HTML → Markdown legível, sem scripts, estilos ou imagens remotas. */
export function htmlToMarkdown(html: string, baseUrl?: string, opts: { readability?: boolean } = {}): { title: string | null; markdown: string } {
  const { document } = parseHTML(html);
  let title: string | null = document.querySelector('title')?.textContent?.trim() || null;
  let contentHtml: string = document.body?.innerHTML || html;
  if (opts.readability !== false) {
    try {
      const article = new Readability(document.cloneNode(true) as unknown as Document, { charThreshold: 200 }).parse();
      // Só substitui o corpo quando o Readability de fato extraiu um artigo.
      if (article?.content && (article.textContent?.trim().length ?? 0) >= 200) {
        contentHtml = article.content;
        title = article.title?.trim() || title;
      }
    } catch {
      // Readability falha em HTML atípico; usa o corpo inteiro.
    }
  }
  let markdown = turndown.turndown(contentHtml);
  if (baseUrl) markdown = markdown.replace(/\]\((\/[^)\s]*)\)/g, (_m, p: string) => `](${new URL(p, baseUrl).toString()})`);
  return { title, markdown: markdown.replace(/\n{3,}/g, '\n\n').trim() };
}

/** Texto puro a partir de HTML (e-mails): sem tags, entidades decodificadas. */
export function htmlToText(html: string): string {
  return htmlToMarkdown(html, undefined, { readability: false }).markdown.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
}

export function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}\n\n[conteúdo truncado: ${text.length - maxChars} caracteres omitidos]`, truncated: true };
}
