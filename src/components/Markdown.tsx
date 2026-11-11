'use client';

import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { normalizeMath } from '@/shared/math';

const SAFE_PROTOCOLS = /^(https?:|mailto:)/i;

/**
 * Markdown do modelo renderizado sem HTML cru. Imagens viram texto alternativo, para nada ser
 * carregado de origens externas. Links só http(s)/mailto, em nova aba sem referrer.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false, trust: false }]]}
        skipHtml
        urlTransform={(url) => (SAFE_PROTOCOLS.test(url) ? url : '')}
        components={{
          img: ({ alt }) => <span>{alt ? `[imagem: ${alt}]` : '[imagem]'}</span>,
          a: ({ href, children }) =>
            href ? (
              <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="underline">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
        }}
      >
        {normalizeMath(text)}
      </ReactMarkdown>
    </div>
  );
}
