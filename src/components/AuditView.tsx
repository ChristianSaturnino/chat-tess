'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { btn, input, PageHeader } from './ui';

type AuditEvent = { id: number; actorUserId: string | null; action: string; entityType: string; entityId: string | null; runId: string | null; traceId: string | null; payload: Record<string, unknown>; createdAt: string };

export function AuditView({ isAdmin }: { isAdmin: boolean }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [all, setAll] = useState(false);
  const [action, setAction] = useState('');
  const [more, setMore] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (before?: number) => {
      const q = new URLSearchParams({ limit: '50' });
      if (all) q.set('all', '1');
      if (action) q.set('action', action);
      if (before) q.set('before', String(before));
      const r = await api<{ events: AuditEvent[] }>(`/api/audit?${q}`);
      setEvents((prev) => (before ? [...prev, ...r.events] : r.events));
      setMore(r.events.length === 50);
    },
    [all, action],
  );

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);

  return (
    <>
      <PageHeader title="Auditoria">
        <a href="/" className={btn}>Voltar ao chat</a>
      </PageHeader>
      <main className="mx-auto max-w-5xl space-y-4 px-4 py-6">
        <div className="flex flex-wrap items-center gap-3">
          <input className={`${input} w-56`} placeholder="filtrar ação (ex.: tool.)" value={action} onChange={(e) => setAction(e.target.value)} />
          {isAdmin && (
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} className="accent-[var(--accent)]" /> todos os usuários
            </label>
          )}
          <p className="text-xs text-muted sm:ml-auto">
            {all ? 'Eventos de todos os usuários (visão de administrador).' : 'Eventos em que você é o ator.'} Registro append-only; payloads sanitizados.
          </p>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full text-left text-xs">
            <thead className="bg-subtle text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Quando</th>
                <th className="px-3 py-2 font-medium">Ação</th>
                <th className="px-3 py-2 font-medium">Entidade</th>
                {all && <th className="px-3 py-2 font-medium">Ator</th>}
                <th className="px-3 py-2 font-medium">Detalhes</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-t border-line align-top">
                  <td className="whitespace-nowrap px-3 py-2 text-muted">{new Date(e.createdAt).toLocaleString('pt-BR')}</td>
                  <td className="px-3 py-2">
                    <span className="whitespace-nowrap rounded-md bg-accent-soft px-1.5 py-0.5 font-mono text-[11px] text-accent-ink">{e.action}</span>
                  </td>
                  <td className="px-3 py-2">
                    {e.entityType}
                    {e.entityId && <span className="font-mono text-muted"> {e.entityId.slice(0, 8)}</span>}
                  </td>
                  {all && <td className="px-3 py-2 font-mono">{e.actorUserId?.slice(0, 8) ?? 'sistema'}</td>}
                  <td className="max-w-md break-words px-3 py-2 font-mono text-[11px] text-muted">{JSON.stringify(e.payload)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {events.length === 0 && <p className="px-3 py-8 text-center text-sm text-muted">Nenhum evento.</p>}
        </div>
        {more && events.length > 0 && (
          <button className={btn} onClick={() => load(events.at(-1)!.id).catch((e) => setError(e.message))}>Carregar mais</button>
        )}
      </main>
    </>
  );
}
