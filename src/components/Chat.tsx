'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationSnapshotDto, MessageDto, RunEventDto } from '@/shared/events';
import { api } from './api';
import { Connectors } from './Connectors';
import { describeEvent, ExecutionFooter, ExecutionPanel } from './Execution';
import { Markdown } from './Markdown';
import { MemoryPanel } from './Memory';
import { SharePanel } from './Share';
import { credits } from './ui';

type ConvSummary = { id: string; title: string | null };
type Privacy = { hasPrivateData: boolean; externalAccessAllowed: boolean };
type Credits = { availableMicro: number; reservedMicro: number; settledMicro: number; limitMicro: number } | null;
type ToolItem = { key: string; label: string; kind: string; available: boolean; unavailableReason?: string; enabled: boolean };
type PendingFile = { id: string; filename: string; mimeType: string };


function applyEvent(msgs: MessageDto[], ev: RunEventDto): MessageDto[] {
  const p = ev.payload as Record<string, unknown>;
  const id = p.messageId as string | undefined;
  if (!id) return msgs;
  return msgs.map((m) => {
    if (m.id !== id) return m;
    switch (ev.type) {
      case 'attempt_started':
        // Nova geração recomeça depois do texto já confirmado por etapas anteriores.
        return { ...m, status: 'streaming', contentText: (p.baseText as string | undefined) ?? '' };
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

function Sources({ sources }: { sources: MessageDto['sources'] }) {
  if (!sources.length) return null;
  const cited = sources.filter((s) => s.cited);
  const consulted = sources.filter((s) => !s.cited);
  const item = (s: MessageDto['sources'][number]) => (
    <li key={s.label} className="truncate">
      <span className="font-mono">[{s.label}]</span> <span className="text-[var(--muted)]">{s.kind}</span>{' '}
      {s.url && s.kind === 'web' ? (
        <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="underline">{s.title ?? s.url}</a>
      ) : (
        <span>{s.title ?? '(sem título)'}</span>
      )}
    </li>
  );
  return (
    <div className="mt-2 space-y-1 rounded-md border border-[var(--border)] p-2 text-xs">
      {cited.length > 0 && (
        <>
          <div className="font-medium">Fontes citadas</div>
          <ul>{cited.map(item)}</ul>
        </>
      )}
      {consulted.length > 0 && (
        <>
          <div className="font-medium text-[var(--muted)]">Consultadas sem citação</div>
          <ul className="text-[var(--muted)]">{consulted.map(item)}</ul>
        </>
      )}
    </div>
  );
}

export function Chat({ user }: { user: { name: string | null; kind: string; role: string } }) {
  const [convs, setConvs] = useState<ConvSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<MessageDto[]>([]);
  const [run, setRun] = useState<{ id: string; cursor: number } | null>(null);
  const [runEvents, setRunEvents] = useState<RunEventDto[]>([]);
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credit, setCredit] = useState<Credits>(null);
  const [tools, setTools] = useState<ToolItem[]>([]);
  const [showTools, setShowTools] = useState(false);
  const [showConnectors, setShowConnectors] = useState(false);
  const [privacy, setPrivacy] = useState<Privacy>({ hasPrivateData: false, externalAccessAllowed: false });
  const [panel, setPanel] = useState<{ kind: 'execution'; runId: string } | { kind: 'memory' } | { kind: 'share' } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const creating = useRef<Promise<string> | null>(null);

  const refreshMe = useCallback(async () => {
    const me = await api<{ credits: Credits }>('/api/me');
    setCredit(me.credits);
  }, []);

  const refreshConvs = useCallback(async () => {
    const r = await api<{ conversations: ConvSummary[] }>('/api/conversations');
    setConvs(r.conversations);
    return r.conversations;
  }, []);

  const loadTools = useCallback(async (convId: string) => {
    const r = await api<{ tools: ToolItem[] }>(`/api/conversations/${convId}/tools`);
    setTools(r.tools);
  }, []);

  const loadConversation = useCallback(
    async (id: string) => {
      const snap = await api<ConversationSnapshotDto>(`/api/conversations/${id}`);
      setActiveId(id);
      setMsgs(snap.messages);
      setPrivacy(snap.conversation);
      setRunEvents([]);
      setRun(snap.activeRun ? { id: snap.activeRun.id, cursor: snap.activeRun.lastEventSeq } : null);
      try {
        localStorage.setItem('tess:lastConversation', id);
      } catch {}
      await loadTools(id);
    },
    [loadTools],
  );

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
      if (new URLSearchParams(window.location.search).has('connectors')) setShowConnectors(true);
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
      // Recarrega para trazer fontes vinculadas na finalização.
      if (activeId)
        void api<ConversationSnapshotDto>(`/api/conversations/${activeId}`).then((s) => {
          setMsgs(s.messages);
          setPrivacy(s.conversation);
        });
    });
    return () => es.close();
  }, [run, activeId, refreshMe, refreshConvs]);

  useEffect(() => {
    // Não retornar o valor: navegadores recentes devolvem uma Promise, que o React trataria como cleanup.
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [msgs]);

  /**
   * A criação fica num ref, não no estado: um envio feito antes de o React re-renderizar
   * espera a conversa nova em vez de usar o activeId anterior.
   */
  function startConversation() {
    const pending = api<{ conversation: ConvSummary }>('/api/conversations', { method: 'POST' }).then(async (r) => {
      await refreshConvs();
      await loadConversation(r.conversation.id);
      return r.conversation.id;
    });
    creating.current = pending;
    void pending.finally(() => {
      if (creating.current === pending) creating.current = null;
    });
    return pending;
  }

  async function ensureConversation() {
    if (creating.current) return creating.current;
    if (activeId) return activeId;
    return startConversation();
  }

  async function newConversation() {
    if (run || creating.current) return;
    setActiveId(null);
    setMsgs([]);
    setTools([]);
    setRunEvents([]);
    setPanel(null);
    setPrivacy({ hasPrivateData: false, externalAccessAllowed: false });
    await startConversation().catch((e) => setError((e as Error).message));
  }

  async function setExternalAccess(allowed: boolean) {
    if (!activeId) return;
    if (
      allowed &&
      !window.confirm(
        'Liberar acesso externo nesta conversa?\n\nA busca na web e a leitura de páginas novas voltam a funcionar. ' +
          'O modelo poderá incluir trechos dos seus anexos, documentos ou e-mails nas buscas e nos endereços que acessar.',
      )
    )
      return;
    try {
      await api(`/api/conversations/${activeId}/external-access`, { method: 'PUT', body: JSON.stringify({ allowed }) });
      setPrivacy((p) => ({ ...p, externalAccessAllowed: allowed }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function upload(list: FileList | null) {
    if (!list?.length) return;
    setUploading(true);
    setError(null);
    try {
      for (const f of Array.from(list)) {
        const form = new FormData();
        form.append('file', f);
        const r = await api<{ attachment: PendingFile }>('/api/attachments', { method: 'POST', body: form });
        setFiles((prev) => [...prev, r.attachment]);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function send() {
    const text = draft.trim();
    if (!text || run || uploading) return;
    setError(null);
    setShowTools(false);
    try {
      const convId = await ensureConversation();
      const idempotencyKey = crypto.randomUUID();
      await api(`/api/conversations/${convId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text, idempotencyKey, attachmentIds: files.map((f) => f.id) }),
      });
      setDraft('');
      setFiles([]);
      await refreshConvs();
      await loadConversation(convId);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function toggleTool(t: ToolItem) {
    try {
      const convId = await ensureConversation();
      const r = await api<{ tools: ToolItem[] }>(`/api/conversations/${convId}/tools`, {
        method: 'PUT',
        body: JSON.stringify({ toolKey: t.key, enabled: !t.enabled }),
      });
      setTools(r.tools);
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

  const timeline = runEvents.map((e) => ({ seq: e.seq, text: describeEvent(e) })).filter((e) => e.text);
  const enabledCount = tools.filter((t) => t.enabled).length;

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
        <div className="space-y-1 border-t border-[var(--border)] p-3 text-xs text-[var(--muted)]">
          <button onClick={() => setShowConnectors(true)} className="w-full rounded border border-[var(--border)] px-2 py-1 text-left text-[var(--text)]">
            Conectores
          </button>
          <div>{user.name ?? 'Usuário'} {user.kind === 'demo' && '(demo)'}</div>
          {credit && (
            <div title="1 crédito = US$ 0,001">
              <div>{credits(credit.availableMicro)} de {credits(credit.limitMicro)} créditos disponíveis</div>
              <div>{credits(credit.settledMicro)} confirmados · {credits(credit.reservedMicro)} reservados</div>
            </div>
          )}
          <div className="flex gap-3">
            <a href="/audit" className="underline">Auditoria</a>
            {user.role === 'admin' && <a href="/admin" className="underline">Admin</a>}
            <button onClick={logout} className="underline">Sair</button>
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {activeId && (
          <header className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate font-medium">{convs.find((c) => c.id === activeId)?.title ?? 'Nova conversa'}</span>
            <button onClick={() => setPanel({ kind: 'memory' })} className="rounded border border-[var(--border)] px-2 py-1 text-xs">Memória</button>
            <button onClick={() => setPanel({ kind: 'share' })} className="rounded border border-[var(--border)] px-2 py-1 text-xs">Compartilhar</button>
          </header>
        )}
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
            {msgs.length === 0 && <p className="text-center text-sm text-[var(--muted)]">Comece uma conversa.</p>}
            {msgs.map((m) => (
              <div key={m.id} className={m.role === 'user' ? 'flex flex-col items-end' : ''}>
                {m.attachments.length > 0 && (
                  <div className="mb-1 flex flex-wrap justify-end gap-1">
                    {m.attachments.map((a) => (
                      <a key={a.id} href={`/api/attachments/${a.id}`} target="_blank" rel="noopener noreferrer" className="rounded border border-[var(--border)] px-2 py-0.5 text-xs">
                        📎 {a.filename}
                      </a>
                    ))}
                  </div>
                )}
                <div
                  className={
                    m.role === 'user'
                      ? 'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-[var(--accent)] px-4 py-2 text-white'
                      : 'break-words'
                  }
                >
                  {m.role === 'assistant' && m.contentText ? (
                    <Markdown text={m.contentText} />
                  ) : (
                    m.contentText || (m.status === 'pending' || m.status === 'streaming' ? '…' : '')
                  )}
                  {m.role === 'assistant' && m.status !== 'completed' && m.status !== 'streaming' && m.status !== 'pending' && (
                    <span className="ml-2 text-xs text-[var(--muted)]">[{m.status === 'cancelled' ? 'cancelada' : 'falhou'}]</span>
                  )}
                </div>
                {m.role === 'assistant' && <Sources sources={m.sources} />}
                {m.role === 'assistant' && run && m.runId === run.id && timeline.length > 0 && (
                  <ol className="mt-1 space-y-0.5 text-xs text-[var(--muted)]" aria-live="polite">
                    {timeline.map((e) => (
                      <li key={e.seq} className="break-words">{e.text}</li>
                    ))}
                  </ol>
                )}
                {m.role === 'assistant' && m.execution && !(run && m.runId === run.id) && (
                  <ExecutionFooter execution={m.execution} onOpen={() => setPanel({ kind: 'execution', runId: m.execution!.runId })} />
                )}
              </div>
            ))}
            <div ref={bottom} />
          </div>
        </div>

        <div className="border-t border-[var(--border)] bg-[var(--panel)]">
          <div className="mx-auto max-w-3xl space-y-2 px-4 py-3">
            {privacy.hasPrivateData &&
              (privacy.externalAccessAllowed ? (
                <p className="text-xs text-[var(--muted)]">
                  Acesso externo liberado nesta conversa.{' '}
                  <button onClick={() => setExternalAccess(false)} className="underline">Bloquear de novo</button>
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-[var(--border)] px-3 py-2 text-xs">
                  <span className="min-w-0 flex-1">
                    Esta conversa tem dados privados (anexos, Drive ou Gmail). Busca na web e páginas novas ficam bloqueadas para evitar vazamento.
                  </span>
                  <button onClick={() => setExternalAccess(true)} className="rounded border border-[var(--border)] px-2 py-1">
                    Liberar acesso externo
                  </button>
                </div>
              ))}
            {files.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {files.map((f) => (
                  <span key={f.id} className="flex items-center gap-1 rounded border border-[var(--border)] px-2 py-0.5 text-xs">
                    📎 {f.filename}
                    <button aria-label={`remover ${f.filename}`} onClick={() => setFiles(files.filter((x) => x.id !== f.id))}>×</button>
                  </span>
                ))}
              </div>
            )}
            <div className="relative flex gap-2">
              <div className="flex flex-col gap-1">
                <button
                  onClick={() => fileInput.current?.click()}
                  disabled={uploading || files.length >= 5}
                  className="rounded-md border border-[var(--border)] px-2 py-1 text-xs disabled:opacity-50"
                  title="Anexar imagem ou PDF (até 10 MB)"
                >
                  {uploading ? '…' : 'Anexar'}
                </button>
                <button onClick={() => setShowTools((v) => !v)} className="rounded-md border border-[var(--border)] px-2 py-1 text-xs">
                  Ferramentas ({enabledCount})
                </button>
              </div>
              <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf" multiple hidden onChange={(e) => upload(e.target.files)} />
              {showTools && (
                <div className="absolute bottom-full left-0 z-10 mb-2 w-72 rounded-md border border-[var(--border)] bg-[var(--panel)] p-2 text-sm shadow">
                  <div className="mb-1 text-xs text-[var(--muted)]">Ferramentas desta conversa</div>
                  {tools.length === 0 && <div className="text-xs text-[var(--muted)]">Envie uma mensagem para criar a conversa.</div>}
                  {tools.map((t) => (
                    <label key={t.key} className={`flex items-start gap-2 py-1 ${t.available ? '' : 'opacity-50'}`}>
                      <input type="checkbox" checked={t.enabled} disabled={!t.available} onChange={() => toggleTool(t)} className="mt-1" />
                      <span>
                        {t.label} <span className="text-xs text-[var(--muted)]">{t.kind}</span>
                        {!t.available && t.unavailableReason && <span className="block text-xs text-[var(--muted)]">{t.unavailableReason}</span>}
                      </span>
                    </label>
                  ))}
                  <button onClick={() => setShowConnectors(true)} className="mt-1 text-xs underline">Gerenciar conectores</button>
                </div>
              )}
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
                className="min-w-0 flex-1 resize-none rounded-md border border-[var(--border)] bg-transparent px-3 py-2 text-sm outline-none"
              />
              {run ? (
                <button onClick={cancel} className="rounded-md border border-[var(--border)] px-4 text-sm">
                  Cancelar
                </button>
              ) : (
                <button onClick={send} disabled={!draft.trim() || uploading} className="rounded-md bg-[var(--accent)] px-4 text-sm text-white disabled:opacity-50">
                  Enviar
                </button>
              )}
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
        </div>
      </main>

      {panel?.kind === 'execution' && <ExecutionPanel runId={panel.runId} onClose={() => setPanel(null)} />}
      {panel?.kind === 'memory' && activeId && <MemoryPanel conversationId={activeId} onClose={() => setPanel(null)} />}
      {panel?.kind === 'share' && activeId && <SharePanel conversationId={activeId} onClose={() => setPanel(null)} />}
      {showConnectors && (
        <Connectors
          onClose={() => {
            setShowConnectors(false);
            if (activeId) void loadTools(activeId);
          }}
        />
      )}
    </div>
  );
}
