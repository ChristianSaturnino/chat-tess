'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import { credits, Drawer } from './ui';

type Version = {
  version: number;
  cutoffSeq: number;
  rendered: string;
  model: string;
  tokensBefore: number;
  tokensAfter: number;
  costMicro: number;
  createdAt: string;
  active: boolean;
};

export function MemoryPanel({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ versions: Version[] }>(`/api/conversations/${conversationId}/memory`).then((r) => setVersions(r.versions), (e) => setError(e.message));
  }, [conversationId]);

  return (
    <Drawer title="Memória da conversa" onClose={onClose}>
      <p className="mb-3 text-xs text-[var(--muted)]">
        Quando o histórico passa do orçamento de contexto, as mensagens antigas são resumidas. O texto da versão ativa é exatamente o que o
        modelo recebe no lugar delas. O histórico completo continua visível no chat. Resumos perdem detalhes.
      </p>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {versions?.length === 0 && <p className="text-sm text-[var(--muted)]">Nenhuma compactação ainda: o modelo recebe o histórico completo.</p>}
      <div className="space-y-3">
        {versions?.map((v) => (
          <details key={v.version} open={v.active} className="rounded border border-[var(--border)] p-2">
            <summary className="text-sm">
              v{v.version} {v.active && <span className="text-[var(--accent)]">(ativa)</span>} · mensagens até #{v.cutoffSeq}
            </summary>
            <div className="mt-1 text-xs text-[var(--muted)]">
              {new Date(v.createdAt).toLocaleString('pt-BR')} · {v.model} · ~{v.tokensBefore} → ~{v.tokensAfter} tokens · {credits(v.costMicro)} créditos
            </div>
            <pre className="mt-2 whitespace-pre-wrap break-words text-xs">{v.rendered}</pre>
          </details>
        ))}
      </div>
    </Drawer>
  );
}
