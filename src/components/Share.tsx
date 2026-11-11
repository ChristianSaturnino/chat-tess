'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ShareProjection } from '@/db/schema';
import { api } from './api';
import { Badge, btn, btnPrimary, Drawer, input, label } from './ui';

type Preview = {
  projection: ShareProjection;
  privateData: boolean;
  liveAllowed: boolean;
  attachments: { id: string; filename: string }[];
  privateSources: number;
};
type ShareRow = { id: string; mode: string; createdAt: string; expiresAt: string | null; revokedAt: string | null; attachments: number; messages: number | null };

export function SharePanel({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [list, setList] = useState<ShareRow[]>([]);
  const [mode, setMode] = useState<'snapshot' | 'live'>('snapshot');
  const [allowed, setAllowed] = useState<string[]>([]);
  const [expires, setExpires] = useState<number | null>(7);
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [p, l] = await Promise.all([
      api<Preview>(`/api/conversations/${conversationId}/shares/preview`),
      api<{ shares: ShareRow[] }>(`/api/conversations/${conversationId}/shares`),
    ]);
    setPreview(p);
    setList(l.shares);
  }, [conversationId]);

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);

  async function create() {
    setError(null);
    try {
      const r = await api<{ url: string }>(`/api/conversations/${conversationId}/shares`, {
        method: 'POST',
        body: JSON.stringify({ mode, attachmentIds: allowed, expiresInDays: expires }),
      });
      setCreated(r.url);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function revoke(id: string) {
    await api(`/api/shares/${id}`, { method: 'DELETE' }).catch((e) => setError(e.message));
    await load();
  }

  return (
    <Drawer title="Compartilhar conversa" subtitle="Link público somente leitura, com prévia do que será publicado." onClose={onClose}>
      {error && <p className="mb-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
      {!preview && !error && <p className="text-sm text-muted">Carregando prévia…</p>}
      {preview && (
        <div className="space-y-6 text-sm">
          <section className="space-y-2">
            <h3 className={label}>O que será publicado</h3>
            <p className="text-xs leading-relaxed text-muted">
              {preview.projection.messages.length} mensagens concluídas, com fontes e etapas resumidas. Não entram: argumentos e resultados de
              ferramentas, dados internos do provider, auditoria e mensagens em andamento.
              {preview.privateSources > 0 && ` ${preview.privateSources} referência(s) a Drive/Gmail/anexos aparecem só pelo título, sem acesso ao original.`}
            </p>
            <div className="max-h-64 space-y-2.5 overflow-y-auto rounded-xl border border-line bg-subtle p-3 text-xs">
              {preview.projection.messages.map((m) => (
                <div key={m.seq}>
                  <span className="font-medium">{m.role === 'user' ? 'Usuário' : 'Tess'}:</span>{' '}
                  <span className="whitespace-pre-wrap">{m.contentText.slice(0, 400)}{m.contentText.length > 400 ? '…' : ''}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <h3 className={`${label} mb-2`}>Modo</h3>
            <label className={`flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 transition-colors ${mode === 'snapshot' ? 'border-accent bg-accent-soft/50' : 'border-line hover:bg-subtle'}`}>
              <input type="radio" checked={mode === 'snapshot'} onChange={() => setMode('snapshot')} className="mt-1 accent-[var(--accent)]" />
              <span>Snapshot: congela as mensagens de agora. Mensagens futuras não aparecem.</span>
            </label>
            <label className={`flex items-start gap-2.5 rounded-xl border p-3 transition-colors ${mode === 'live' ? 'border-accent bg-accent-soft/50' : 'border-line'} ${preview.liveAllowed ? 'cursor-pointer hover:bg-subtle' : 'opacity-50'}`}>
              <input type="radio" checked={mode === 'live'} disabled={!preview.liveAllowed} onChange={() => setMode('live')} className="mt-1 accent-[var(--accent)]" />
              <span>
                Live: publica também as mensagens futuras desta conversa.
                {!preview.liveAllowed && ' Indisponível: a conversa contém anexos ou fontes privadas.'}
              </span>
            </label>
          </section>

          {preview.attachments.length > 0 && (
            <section className="space-y-1">
              <h3 className={`${label} mb-2`}>Anexos liberados para download</h3>
              {preview.attachments.map((a) => (
                <label key={a.id} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={allowed.includes(a.id)}
                    onChange={(e) => setAllowed(e.target.checked ? [...allowed, a.id] : allowed.filter((x) => x !== a.id))}
                  />
                  {a.filename}
                </label>
              ))}
              <p className="text-xs text-muted">Anexos não marcados aparecem só pelo nome.</p>
            </section>
          )}

          <section className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <span className="text-muted">Expira em</span>
            <select value={expires ?? ''} onChange={(e) => setExpires(e.target.value ? Number(e.target.value) : null)} className={`${input} w-auto`}>
              <option value={1}>1 dia</option>
              <option value={7}>7 dias</option>
              <option value={30}>30 dias</option>
              <option value="">nunca</option>
            </select>
            <button onClick={create} className={`${btnPrimary} ml-auto`}>Publicar link</button>
          </section>

          {created && (
            <div className="rounded-xl border border-accent bg-accent-soft/50 p-3 text-xs">
              <div className="mb-2 font-medium text-accent-ink">Link criado (aparece só agora; guarde-o):</div>
              <div className="flex gap-2">
                <input readOnly value={created} className={`${input} min-w-0 flex-1 font-mono text-xs`} onFocus={(e) => e.target.select()} />
                <button className={btn} onClick={() => navigator.clipboard?.writeText(created)}>Copiar</button>
              </div>
            </div>
          )}

          {list.length > 0 && (
            <section className="space-y-1">
              <h3 className={`${label} mb-2`}>Links desta conversa</h3>
              {list.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-xs">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={s.revokedAt ? 'neutral' : 'accent'}>{s.mode}</Badge> criado {new Date(s.createdAt).toLocaleString('pt-BR')} ·{' '}
                    {s.revokedAt ? 'revogado' : s.expiresAt ? `expira ${new Date(s.expiresAt).toLocaleDateString('pt-BR')}` : 'sem expiração'}
                  </span>
                  {!s.revokedAt && <button className={btn} onClick={() => revoke(s.id)}>Revogar</button>}
                </div>
              ))}
            </section>
          )}
        </div>
      )}
    </Drawer>
  );
}
