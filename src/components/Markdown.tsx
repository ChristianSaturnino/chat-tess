'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const SAFE_PROTOCOLS = /^(https?:|mailto:)/i;

/**
 * Markdown do modelo renderizado sem HTML cru (react-markdown ignora HTML por padrão).
 * Imagens viram texto alternativo: nada é carregado automaticamente de origens externas.
 * Links só http(s)/mailto, abertos em nova aba sem referrer.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
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
        {text}
      </ReactMarkdown>
    </div>
  );
}
