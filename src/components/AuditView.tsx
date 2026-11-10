'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { btn, input } from './ui';

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
    <main className="mx-auto max-w-5xl space-y-3 px-4 py-6">
      <div className="flex flex-wrap items-center gap-2">
        <a href="/" className="text-sm underline">← Chat</a>
        <h1 className="mr-auto text-lg font-semibold">Auditoria</h1>
        <input className={`${input} w-48`} placeholder="filtrar ação (ex.: tool.)" value={action} onChange={(e) => setAction(e.target.value)} />
        {isAdmin && (
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> todos os usuários
          </label>
        )}
      </div>
      <p className="text-xs text-[var(--muted)]">
        {all ? 'Eventos de todos os usuários (visão de administrador).' : 'Eventos em que você é o ator.'} Registro append-only; payloads sanitizados.
      </p>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-[var(--muted)]">
            <tr>
              <th className="py-1 pr-2">Quando</th>
              <th className="pr-2">Ação</th>
              <th className="pr-2">Entidade</th>
              {all && <th className="pr-2">Ator</th>}
              <th>Detalhes</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id} className="border-t border-[var(--border)] align-top">
                <td className="whitespace-nowrap py-1 pr-2">{new Date(e.createdAt).toLocaleString('pt-BR')}</td>
                <td className="pr-2 font-mono">{e.action}</td>
                <td className="pr-2">{e.entityType}{e.entityId ? ` ${e.entityId.slice(0, 8)}` : ''}</td>
                {all && <td className="pr-2 font-mono">{e.actorUserId?.slice(0, 8) ?? 'sistema'}</td>}
                <td className="max-w-md break-words font-mono text-[var(--muted)]">{JSON.stringify(e.payload)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more && events.length > 0 && (
        <button className={btn} onClick={() => load(events.at(-1)!.id).catch((e) => setError(e.message))}>Carregar mais</button>
      )}
    </main>
  );
}
