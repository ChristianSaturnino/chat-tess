'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { btn, credits, input } from './ui';

type Account = { limitMicro: number; settledMicro: number; reservedMicro: number };
type UserRow = { id: string; kind: string; role: string; email: string | null; name: string | null; createdAt: string; limitMicro: number | null; settledMicro: number | null; reservedMicro: number | null };

export function AdminView() {
  const [global, setGlobal] = useState<Account | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [edit, setEdit] = useState<{ target: { userId: string } | { global: true }; label: string; credits: string; reason: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ global: Account; users: UserRow[] }>('/api/admin/credits');
    setGlobal(r.global);
    setUsers(r.users);
  }, []);

  useEffect(() => {
    load().catch((e) => setMsg(e.message));
  }, [load]);

  async function save() {
    if (!edit) return;
    setMsg(null);
    try {
      const limitMicro = Math.round(Number(edit.credits.replace(',', '.')) * 1000);
      await api('/api/admin/credits', { method: 'PUT', body: JSON.stringify({ target: edit.target, limitMicro, reason: edit.reason }) });
      setEdit(null);
      setMsg('Limite atualizado e registrado na auditoria.');
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  const usage = (a: { limitMicro: number | null; settledMicro: number | null; reservedMicro: number | null }) =>
    a.limitMicro === null ? '—' : `${credits(a.settledMicro ?? 0)} confirmados · ${credits(a.reservedMicro ?? 0)} reservados · limite ${credits(a.limitMicro)}`;

  return (
    <main className="mx-auto max-w-5xl space-y-4 px-4 py-6">
      <div className="flex items-center gap-3">
        <a href="/" className="text-sm underline">← Chat</a>
        <h1 className="mr-auto text-lg font-semibold">Admin · cotas</h1>
        <a href="/audit" className="text-sm underline">Auditoria</a>
      </div>
      {msg && <p className="text-sm text-[var(--muted)]">{msg}</p>}
      {global && (
        <section className="flex items-center justify-between rounded border border-[var(--border)] p-3 text-sm">
          <div>
            <div className="font-medium">Cap global (todos os usuários)</div>
            <div className="text-xs text-[var(--muted)]">{usage(global)} · 1 crédito = US$ 0,001</div>
          </div>
          <button className={btn} onClick={() => setEdit({ target: { global: true }, label: 'Cap global', credits: String(global.limitMicro / 1000), reason: '' })}>Ajustar</button>
        </section>
      )}
      {edit && (
        <section className="space-y-2 rounded border border-[var(--border)] p-3 text-sm">
          <div className="font-medium">Novo limite: {edit.label}</div>
          <div className="grid gap-2 sm:grid-cols-[10rem_1fr_auto]">
            <input className={input} value={edit.credits} onChange={(e) => setEdit({ ...edit, credits: e.target.value })} aria-label="limite em créditos" />
            <input className={input} placeholder="motivo (registrado na auditoria)" value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} />
            <div className="flex gap-2">
              <button className={btn} disabled={edit.reason.length < 3} onClick={save}>Salvar</button>
              <button className={btn} onClick={() => setEdit(null)}>Cancelar</button>
            </div>
          </div>
        </section>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-[var(--muted)]">
            <tr>
              <th className="py-1 pr-2">Usuário</th>
              <th className="pr-2">Tipo</th>
              <th className="pr-2">Consumo</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-[var(--border)]">
                <td className="py-1 pr-2">{u.email ?? u.name ?? u.id.slice(0, 8)}{u.role === 'admin' && ' (admin)'}</td>
                <td className="pr-2">{u.kind}</td>
                <td className="pr-2">{usage(u)}</td>
                <td>
                  {u.limitMicro !== null && (
                    <button className={btn} onClick={() => setEdit({ target: { userId: u.id }, label: u.email ?? u.name ?? u.id, credits: String(u.limitMicro! / 1000), reason: '' })}>Ajustar</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
