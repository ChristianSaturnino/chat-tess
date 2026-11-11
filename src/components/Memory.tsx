'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import { Badge, credits, Drawer } from './ui';

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
    <Drawer title="Memória da conversa" subtitle="O texto da versão ativa é exatamente o que o modelo recebe no lugar das mensagens antigas." onClose={onClose}>
      <p className="mb-4 rounded-lg bg-subtle px-3 py-2.5 text-xs leading-relaxed text-muted">
        Quando o histórico passa do orçamento de contexto, as mensagens antigas são resumidas. O histórico completo continua visível no chat.
        Resumos perdem detalhes.
      </p>
      {error && <p className="text-sm text-danger">{error}</p>}
      {versions?.length === 0 && (
        <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
          Nenhuma compactação ainda: o modelo recebe o histórico completo.
        </div>
      )}
      <div className="space-y-2.5">
        {versions?.map((v) => (
          <details key={v.version} open={v.active} className="rounded-xl border border-line">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2.5 text-sm">
              <span className="font-semibold">v{v.version}</span>
              {v.active && <Badge tone="accent">ativa</Badge>}
              <span className="text-muted">mensagens até #{v.cutoffSeq}</span>
            </summary>
            <div className="border-t border-line px-3.5 py-3">
              <div className="text-[11px] text-muted">
                {new Date(v.createdAt).toLocaleString('pt-BR')} · {v.model} · ~{v.tokensBefore} → ~{v.tokensAfter} tokens · {credits(v.costMicro)} créditos
              </div>
              <pre className="mt-2.5 whitespace-pre-wrap break-words rounded-lg bg-subtle p-3 font-sans text-xs leading-relaxed">{v.rendered}</pre>
            </div>
          </details>
        ))}
      </div>
    </Drawer>
  );
}
