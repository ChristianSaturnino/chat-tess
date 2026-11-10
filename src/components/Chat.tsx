'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationSnapshotDto, MessageDto, RunEventDto } from '@/shared/events';

type ConvSummary = { id: string; title: string | null };
type Credits = { availableMicro: number; reservedMicro: number; settledMicro: number; limitMicro: number } | null;

const credits = (micro: number) => (micro / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 });

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message ?? `erro ${res.status}`);
  return body as T;
}

function applyEvent(msgs: MessageDto[], ev: RunEventDto): MessageDto[] {
  const p = ev.payload as Record<string, unknown>;
  const id = p.messageId as string | undefined;
  if (!id) return msgs;
  return msgs.map((m) => {
    if (m.id !== id) return m;
    switch (ev.type) {
      case 'attempt_started':
        return { ...m, status: 'streaming', contentText: '' }; // nova geração substitui o parcial
      case 'text_delta':
        return { ...m, status: 'streaming', contentText: m.contentText + (p.text as string) };
      case 'run_completed':
        return { ...m, status: 'completed' };
      case 'run_cancelled':
        return { ...m, status: 'cancelled' };
      case 'run_failed':
      case 'run_interrupted':
        return { ...m, status: 'failed', contentText: m.contentText || `⚠ ${(p.error as { message: string }).message}` };
      default:
        return m;
    }
  });
}

export function Chat({ user }: { user: { name: string | null; kind: string } }) {
  const [convs, setConvs] = useState<ConvSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<MessageDto[]>([]);
  const [run, setRun] = useState<{ id: string; cursor: number } | null>(null);
  const [runEvents, setRunEvents] = useState<RunEventDto[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [credit, setCredit] = useState<Credits>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const refreshMe = useCallback(async () => {
    const me = await api<{ credits: Credits }>('/api/me');
    setCredit(me.credits);
  }, []);

  const refreshConvs = useCallback(async () => {
    const r = await api<{ conversations: ConvSummary[] }>('/api/conversations');
    setConvs(r.conversations);
    return r.conversations;
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    const snap = await api<ConversationSnapshotDto>(`/api/conversations/${id}`);
    setActiveId(id);
    setMsgs(snap.messages);
    setRunEvents([]);
    setRun(snap.activeRun ? { id: snap.activeRun.id, cursor: snap.activeRun.lastEventSeq } : null);
    localStorage.setItem('tess:lastConversation', id);
  }, []);

  useEffect(() => {
    (async () => {
      const list = await refreshConvs();
      await refreshMe();
      let last: string | null = null;
      try {
        last = localStorage.getItem('tess:lastConversation');
      } catch {}
      const target = list.find((c) => c.id === last)?.id ?? list[0]?.id;
      if (target) await loadConversation(target);
    })().catch((e) => setError(String(e.message ?? e)));
  }, [refreshConvs, refreshMe, loadConversation]);

  // SSE: o servidor envia eventos persistidos após o cursor; EventSource reconecta com Last-Event-ID.
  useEffect(() => {
    if (!run) return;
    const es = new EventSource(`/api/runs/${run.id}/events?after=${run.cursor}`);
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data) as RunEventDto;
      setMsgs((m) => applyEvent(m, ev));
      setRunEvents((list) => (list.some((x) => x.seq === ev.seq) ? list : [...list, ev]));
    };
    es.addEventListener('end', () => {
      es.close();
      setRun(null);
      void refreshMe();
      void refreshConvs();
    });
    return () => es.close();
  }, [run, refreshMe, refreshConvs]);

  useEffect(() => {
    // Não retornar o valor: navegadores recentes devolvem uma Promise, que o React trataria como cleanup.
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [msgs]);

  async function newConversation() {
    const r = await api<{ conversation: ConvSummary }>('/api/conversations', { method: 'POST' });
    await refreshConvs();
    await loadConversation(r.conversation.id);
  }

  async function send() {
    const text = draft.trim();
    if (!text || run) return;
    setError(null);
    try {
      let convId = activeId;
      if (!convId) {
        const r = await api<{ conversation: ConvSummary }>('/api/conversations', { method: 'POST' });
        convId = r.conversation.id;
      }
      const idempotencyKey = crypto.randomUUID();
      await api(`/api/conversations/${convId}/messages`, { method: 'POST', body: JSON.stringify({ text, idempotencyKey }) });
      setDraft('');
      await refreshConvs();
      await loadConversation(convId);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function cancel() {
    if (run) await api(`/api/runs/${run.id}/cancel`, { method: 'POST' }).catch((e) => setError(e.message));
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.reload();
  }

  return (
    <div className="flex h-dvh">
      <aside className="hidden w-64 flex-col border-r border-[var(--border)] bg-[var(--panel)] md:flex">
        <div className="p-3">
          <button onClick={newConversation} className="w-full rounded-md border border-[var(--border)] px-3 py-2 text-sm">
            + Nova conversa
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2">
          {convs.map((c) => (
            <button
              key={c.id}
              onClick={() => loadConversation(c.id)}
              className={`block w-full truncate rounded px-2 py-1.5 text-left text-sm ${c.id === activeId ? 'bg-[var(--bg)] font-medium' : ''}`}
            >
              {c.title ?? 'Nova conversa'}
            </button>
          ))}
        </nav>
        <div className="border-t border-[var(--border)] p-3 text-xs text-[var(--muted)]">
          <div>{user.name ?? 'Usuário'} {user.kind === 'demo' && '(demo)'}</div>
          {credit && (
            <div className="mt-1">
              {credits(credit.availableMicro)} créditos disponíveis
              {credit.reservedMicro > 0 && ` · ${credits(credit.reservedMicro)} reservados`}
            </div>
          )}
          <button onClick={logout} className="mt-2 underline">Sair</button>
        </div>
      </aside>

      <main className="flex flex-1 flex-col">
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
            {msgs.length === 0 && <p className="text-center text-sm text-[var(--muted)]">Comece uma conversa.</p>}
            {msgs.map((m) => (
              <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : ''}>
                <div
                  className={
                    m.role === 'user'
                      ? 'max-w-[85%] whitespace-pre-wrap rounded-2xl bg-[var(--accent)] px-4 py-2 text-white'
                      : 'whitespace-pre-wrap'
                  }
                >
                  {m.contentText || (m.status === 'pending' || m.status === 'streaming' ? '…' : '')}
                  {m.role === 'assistant' && m.status !== 'completed' && m.status !== 'streaming' && m.status !== 'pending' && (
                    <span className="ml-2 text-xs text-[var(--muted)]">[{m.status === 'cancelled' ? 'cancelada' : 'falhou'}]</span>
                  )}
                </div>
              </div>
            ))}
            {runEvents.length > 0 && (
              <details className="text-xs text-[var(--muted)]">
                <summary>Ver execução ({runEvents.length} eventos)</summary>
                <ol className="mt-1 space-y-0.5">
                  {runEvents
                    .filter((e) => e.type !== 'text_delta')
                    .map((e) => (
                      <li key={e.seq}>
                        #{e.seq} {e.type}
                      </li>
                    ))}
                </ol>
              </details>
            )}
            <div ref={bottom} />
          </div>
        </div>

        <div className="border-t border-[var(--border)] bg-[var(--panel)]">
          <div className="mx-auto flex max-w-3xl gap-2 px-4 py-3">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={2}
              placeholder="Mensagem…"
              className="flex-1 resize-none rounded-md border border-[var(--border)] bg-transparent px-3 py-2 text-sm outline-none"
            />
            {run ? (
              <button onClick={cancel} className="rounded-md border border-[var(--border)] px-4 text-sm">
                Cancelar
              </button>
            ) : (
              <button onClick={send} disabled={!draft.trim()} className="rounded-md bg-[var(--accent)] px-4 text-sm text-white disabled:opacity-50">
                Enviar
              </button>
            )}
          </div>
          {error && <p className="mx-auto max-w-3xl px-4 pb-2 text-sm text-red-600">{error}</p>}
        </div>
      </main>
    </div>
  );
}
