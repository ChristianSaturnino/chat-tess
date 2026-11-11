import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from '@/components/Markdown';
import { normalizeMath } from '@/shared/math';

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe('fórmulas no markdown', () => {
  it('converte delimitadores \\( \\) e \\[ \\] fora de código', () => {
    expect(normalizeMath('raiz \\(x^2\\) fim')).toBe('raiz $$x^2$$ fim');
    expect(normalizeMath('a\n\\[ x = 1 \\]\nb')).toBe('a\n\n$$\nx = 1\n$$\n\nb');
    expect(normalizeMath('`\\(x\\)`')).toBe('`\\(x\\)`');
    expect(normalizeMath('```\n\\[x\\]\n```')).toBe('```\n\\[x\\]\n```');
  });

  it('renderiza a fórmula de Bhaskara com KaTeX', () => {
    const html = render('A fórmula é:\n\\[ x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a} \\]');
    expect(html).toContain('katex-display');
    expect(html).toContain('mfrac');
  });

  it('mantém valores em reais como texto', () => {
    const html = render('Total de R$ 30.938 contra o teto de R$ 30.000.');
    expect(html).not.toContain('katex');
    expect(html).toContain('R$ 30.938');
  });

  it('não executa comandos que carregam conteúdo', () => {
    const html = render('\\(\\href{javascript:alert(1)}{x}\\)');
    expect(html).not.toMatch(/<a\s|href=/);
  });
});
