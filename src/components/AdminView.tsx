'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { Badge, btn, btnPrimary, card, credits, input, label, PageHeader } from './ui';

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
  const usedPct = (a: Account) => Math.min(100, ((a.settledMicro + a.reservedMicro) / Math.max(1, a.limitMicro)) * 100);

  return (
    <>
      <PageHeader title="Admin · cotas">
        <a href="/audit" className={btn}>Auditoria</a>
        <a href="/" className={btn}>Voltar ao chat</a>
      </PageHeader>
      <main className="mx-auto max-w-5xl space-y-5 px-4 py-6">
        {msg && <p className="rounded-lg bg-subtle px-3 py-2 text-sm">{msg}</p>}
        {global && (
          <section className={`${card} flex flex-wrap items-center justify-between gap-4`}>
            <div className="min-w-0 flex-1">
              <div className={label}>Cap global (todos os usuários)</div>
              <div className="mt-1 text-2xl font-semibold tracking-tight">
                {credits(global.limitMicro - global.settledMicro - global.reservedMicro)}
                <span className="ml-1.5 text-sm font-normal text-muted">de {credits(global.limitMicro)} créditos livres</span>
              </div>
              <div className="mt-2.5 h-1.5 max-w-md overflow-hidden rounded-full bg-subtle">
                <div className="h-full rounded-full bg-accent" style={{ width: `${usedPct(global)}%` }} />
              </div>
              <div className="mt-1.5 text-xs text-muted">{usage(global)} · 1 crédito = US$ 0,001</div>
            </div>
            <button className={btn} onClick={() => setEdit({ target: { global: true }, label: 'Cap global', credits: String(global.limitMicro / 1000), reason: '' })}>
              Ajustar
            </button>
          </section>
        )}
        {edit && (
          <section className={`${card} space-y-2.5 border-accent text-sm`}>
            <div className="font-medium">Novo limite: {edit.label}</div>
            <div className="grid gap-2 sm:grid-cols-[10rem_1fr_auto]">
              <input className={input} value={edit.credits} onChange={(e) => setEdit({ ...edit, credits: e.target.value })} aria-label="limite em créditos" />
              <input className={input} placeholder="motivo (registrado na auditoria)" value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} />
              <div className="flex gap-2">
                <button className={`${btnPrimary} py-1.5`} disabled={edit.reason.length < 3} onClick={save}>Salvar</button>
                <button className={btn} onClick={() => setEdit(null)}>Cancelar</button>
              </div>
            </div>
          </section>
        )}
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full text-left text-xs">
            <thead className="bg-subtle text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Usuário</th>
                <th className="px-3 py-2 font-medium">Tipo</th>
                <th className="px-3 py-2 font-medium">Consumo</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-line">
                  <td className="px-3 py-2">
                    {u.email ?? u.name ?? u.id.slice(0, 8)} {u.role === 'admin' && <Badge tone="accent">admin</Badge>}
                  </td>
                  <td className="px-3 py-2"><Badge>{u.kind}</Badge></td>
                  <td className="px-3 py-2 text-muted">{usage(u)}</td>
                  <td className="px-3 py-2 text-right">
                    {u.limitMicro !== null && (
                      <button
                        className={btn}
                        onClick={() => setEdit({ target: { userId: u.id }, label: u.email ?? u.name ?? u.id, credits: String(u.limitMicro! / 1000), reason: '' })}
                      >
                        Ajustar
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}
