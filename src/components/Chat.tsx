'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationSnapshotDto, MessageDto, RunEventDto } from '@/shared/events';
import { api } from './api';
import { Connectors } from './Connectors';
import { describeEvent, ExecutionFooter, ExecutionPanel } from './Execution';
import { IconClip, IconFile, IconGlobe, IconLock, IconMemory, IconMenu, IconPlug, IconPlus, IconSend, IconShare, IconStop, IconTools, IconX } from './icons';
import { Markdown } from './Markdown';
import { MemoryPanel } from './Memory';
import { SharePanel } from './Share';
import { TessAvatar, TessMark, Wordmark } from './brand';
import { Badge, btnGhost, credits } from './ui';

type ConvSummary = { id: string; title: string | null };
type Privacy = { hasPrivateData: boolean; externalAccessAllowed: boolean };
type Credits = { availableMicro: number; reservedMicro: number; settledMicro: number; limitMicro: number } | null;
type ToolItem = { key: string; label: string; kind: string; available: boolean; unavailableReason?: string; enabled: boolean };
type PendingFile = { id: string; filename: string; mimeType: string };

const SUGGESTIONS = [
  'Explique a fórmula de Bhaskara com um exemplo resolvido',
  'Pesquise na web as novidades da última versão do PostgreSQL',
  'Quais ferramentas você tem disponíveis nesta conversa?',
  'Resuma em tópicos o PDF que vou anexar',
];

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

function SourceItem({ s }: { s: MessageDto['sources'][number] }) {
  const Icon = s.kind === 'web' ? IconGlobe : IconFile;
  const title = s.title ?? s.url ?? '(sem título)';
  const body = (
    <>
      <span className="font-mono text-[11px] font-semibold text-accent-ink">{s.label}</span>
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted" />
      <span className="truncate">{title}</span>
      <span className="ml-auto shrink-0 text-[11px] text-muted">{s.kind}</span>
    </>
  );
  const cls = `flex min-w-0 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs ${s.cited ? '' : 'opacity-75'}`;
  return s.url && s.kind === 'web' ? (
    <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className={`${cls} transition-colors hover:border-line-strong hover:bg-subtle`}>
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function Sources({ sources }: { sources: MessageDto['sources'] }) {
  if (!sources.length) return null;
  const cited = sources.filter((s) => s.cited);
  const consulted = sources.filter((s) => !s.cited);
  return (
    <div className="mt-3 space-y-2">
      {cited.length > 0 && (
        <div>
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted">Fontes citadas</div>
          <div className="grid gap-1.5 sm:grid-cols-2">{cited.map((s) => <SourceItem key={s.label} s={s} />)}</div>
        </div>
      )}
      {consulted.length > 0 && (
        <div>
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted">Consultadas sem citação</div>
          <div className="grid gap-1.5 sm:grid-cols-2">{consulted.map((s) => <SourceItem key={s.label} s={s} />)}</div>
        </div>
      )}
    </div>
  );
}

function Typing() {
  return (
    <span className="typing inline-flex items-center py-2" aria-label="gerando resposta">
      <span />
      <span />
      <span />
    </span>
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
  const [navOpen, setNavOpen] = useState(false);
  const [privacy, setPrivacy] = useState<Privacy>({ hasPrivateData: false, externalAccessAllowed: false });
  const [panel, setPanel] = useState<{ kind: 'execution'; runId: string } | { kind: 'memory' } | { kind: 'share' } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const toolsMenu = useRef<HTMLDivElement>(null);
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
      setNavOpen(false);
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

  useEffect(() => {
    if (!showTools) return;
    const onDown = (e: MouseEvent) => {
      if (!toolsMenu.current?.contains(e.target as Node)) setShowTools(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showTools]);

  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [draft]);

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
    textarea.current?.focus();
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
  const title = convs.find((c) => c.id === activeId)?.title ?? 'Nova conversa';
  const usedPct = credit && credit.limitMicro > 0 ? Math.min(100, ((credit.limitMicro - credit.availableMicro) / credit.limitMicro) * 100) : 0;

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
        <Wordmark size={20} />
        <button onClick={() => setNavOpen(false)} className={`${btnGhost} ml-auto h-8 w-8 p-0 md:hidden`} aria-label="Fechar menu">
          <IconX />
        </button>
      </div>
      <div className="px-3">
        <button
          onClick={newConversation}
          className="flex w-full items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium shadow-card transition-colors hover:bg-subtle"
        >
          <IconPlus /> Nova conversa
        </button>
      </div>
      <div className="mt-4 px-4 text-[11px] font-medium uppercase tracking-wider text-muted">Conversas</div>
      <nav className="mt-1 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        {convs.map((c) => (
          <button
            key={c.id}
            onClick={() => loadConversation(c.id)}
            className={`block w-full truncate rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
              c.id === activeId ? 'bg-subtle font-medium text-fg' : 'text-muted hover:bg-subtle/70 hover:text-fg'
            }`}
          >
            {c.title ?? 'Nova conversa'}
          </button>
        ))}
      </nav>
      <div className="space-y-3 border-t border-line p-3">
        <button
          onClick={() => setShowConnectors(true)}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-fg transition-colors hover:bg-subtle"
        >
          <IconPlug className="h-4 w-4 text-muted" /> Conectores
        </button>
        {credit && (
          <div className="rounded-lg bg-subtle px-3 py-2.5" title="1 crédito = US$ 0,001">
            <div className="flex items-baseline justify-between text-xs">
              <span className="font-medium">{credits(credit.availableMicro)} de {credits(credit.limitMicro)} créditos disponíveis</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${usedPct}%` }} />
            </div>
            <div className="mt-1.5 text-[11px] text-muted">
              {credits(credit.settledMicro)} confirmados · {credits(credit.reservedMicro)} reservados
            </div>
          </div>
        )}
        <div className="flex items-center gap-2 px-1">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent-ink">
            {(user.name ?? 'U').slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm">{user.name ?? 'Usuário'}</div>
            <div className="flex gap-2.5 text-[11px] text-muted">
              {user.kind === 'demo' && <span>demo</span>}
              <a href="/audit" className="hover:text-fg">Auditoria</a>
              {user.role === 'admin' && <a href="/admin" className="hover:text-fg">Admin</a>}
              <button onClick={logout} className="hover:text-fg">Sair</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-dvh">
      <aside className="hidden w-72 shrink-0 border-r border-line bg-bg md:block">{sidebar}</aside>
      {navOpen && (
        <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setNavOpen(false)}>
          <aside className="h-full w-72 max-w-[85%] border-r border-line bg-bg shadow-pop" onClick={(e) => e.stopPropagation()}>
            {sidebar}
          </aside>
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col bg-surface">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-5">
          <button onClick={() => setNavOpen(true)} className={`${btnGhost} h-9 w-9 p-0 md:hidden`} aria-label="Abrir menu">
            <IconMenu className="h-5 w-5" />
          </button>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{activeId ? title : 'Chat Tess'}</span>
          {activeId && (
            <>
              <button onClick={() => setPanel({ kind: 'memory' })} className={`${btnGhost} gap-1.5 px-2.5 py-1.5`}>
                <IconMemory /> <span className="hidden sm:inline">Memória</span>
                <span className="sr-only sm:hidden">Memória</span>
              </button>
              <button onClick={() => setPanel({ kind: 'share' })} className={`${btnGhost} gap-1.5 px-2.5 py-1.5`}>
                <IconShare /> <span className="hidden sm:inline">Compartilhar</span>
                <span className="sr-only sm:hidden">Compartilhar</span>
              </button>
            </>
          )}
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
            {msgs.length === 0 && (
              <div className="flex flex-col items-center pt-[8vh] text-center">
                <TessMark size={40} />
                <h2 className="mt-4 text-2xl font-semibold tracking-tight">Como posso ajudar?</h2>
                <p className="mt-1.5 max-w-md text-sm text-muted">
                  Cada resposta mostra as fontes usadas e o que aconteceu na execução. Ative ferramentas e conectores pelo menu abaixo.
                </p>
                <div className="mt-8 grid w-full max-w-xl gap-2 sm:grid-cols-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => {
                        setDraft(s);
                        textarea.current?.focus();
                      }}
                      className="rounded-xl border border-line bg-surface px-3.5 py-3 text-left text-sm text-muted transition-colors hover:border-line-strong hover:bg-subtle hover:text-fg"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="space-y-7">
              {msgs.map((m) =>
                m.role === 'user' ? (
                  <div key={m.id} className="flex flex-col items-end">
                    {m.attachments.length > 0 && (
                      <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
                        {m.attachments.map((a) => (
                          <a
                            key={a.id}
                            href={`/api/attachments/${a.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs transition-colors hover:bg-subtle"
                          >
                            <IconClip className="h-3.5 w-3.5 text-muted" /> {a.filename}
                          </a>
                        ))}
                      </div>
                    )}
                    <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-accent-fg">
                      {m.contentText}
                    </div>
                  </div>
                ) : (
                  <div key={m.id} className="flex gap-3">
                    <div className="pt-0.5">
                      <TessAvatar size={28} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="break-words">
                        {m.contentText ? <Markdown text={m.contentText} /> : (m.status === 'pending' || m.status === 'streaming') && <Typing />}
                        {m.status !== 'completed' && m.status !== 'streaming' && m.status !== 'pending' && (
                          <div className="mt-2">
                            <Badge tone={m.status === 'cancelled' ? 'neutral' : 'danger'}>{m.status === 'cancelled' ? 'cancelada' : 'falhou'}</Badge>
                          </div>
                        )}
                      </div>
                      <Sources sources={m.sources} />
                      {run && m.runId === run.id && timeline.length > 0 && (
                        <ol className="mt-3 space-y-1 border-l-2 border-line pl-3 text-xs text-muted" aria-live="polite">
                          {timeline.map((e, i) => (
                            <li key={e.seq} className={`break-words ${i === timeline.length - 1 ? 'text-fg' : ''}`}>
                              {e.text}
                            </li>
                          ))}
                        </ol>
                      )}
                      {m.execution && !(run && m.runId === run.id) && (
                        <ExecutionFooter execution={m.execution} onOpen={() => setPanel({ kind: 'execution', runId: m.execution!.runId })} />
                      )}
                    </div>
                  </div>
                ),
              )}
            </div>
            <div ref={bottom} />
          </div>
        </div>

        <div className="shrink-0 px-3 pb-4 pt-2 sm:px-6">
          <div className="mx-auto max-w-3xl space-y-2">
            {privacy.hasPrivateData &&
              (privacy.externalAccessAllowed ? (
                <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 px-1 text-xs text-muted">
                  <IconGlobe className="h-3.5 w-3.5" /> Acesso externo liberado nesta conversa.{' '}
                  <button onClick={() => setExternalAccess(false)} className="whitespace-nowrap font-medium text-fg underline underline-offset-2">Bloquear de novo</button>
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-warn-soft px-3.5 py-2.5 text-xs">
                  <IconLock className="h-4 w-4 shrink-0 text-warn" />
                  <span className="min-w-0 flex-1">
                    Esta conversa tem dados privados (anexos, Drive ou Gmail). Busca na web e páginas novas ficam bloqueadas para evitar vazamento.
                  </span>
                  <button
                    onClick={() => setExternalAccess(true)}
                    className="rounded-lg border border-line bg-surface px-2.5 py-1 font-medium transition-colors hover:bg-subtle"
                  >
                    Liberar acesso externo
                  </button>
                </div>
              ))}

            <div className="relative rounded-2xl border border-line bg-surface shadow-card transition-colors focus-within:border-line-strong">
              {files.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-3 pt-3">
                  {files.map((f) => (
                    <span key={f.id} className="flex items-center gap-1.5 rounded-lg bg-subtle px-2.5 py-1 text-xs">
                      <IconClip className="h-3.5 w-3.5 text-muted" /> {f.filename}
                      <button aria-label={`remover ${f.filename}`} onClick={() => setFiles(files.filter((x) => x.id !== f.id))} className="text-muted hover:text-fg">
                        <IconX className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <textarea
                ref={textarea}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={1}
                placeholder="Mensagem…"
                className="block max-h-[220px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[15px] outline-none placeholder:text-muted"
              />
              <div className="flex items-center gap-1 px-2 pb-2">
                <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf" multiple hidden onChange={(e) => upload(e.target.files)} />
                <button
                  onClick={() => fileInput.current?.click()}
                  disabled={uploading || files.length >= 5}
                  className={`${btnGhost} gap-1.5 px-2.5 py-1.5`}
                  title="Anexar imagem ou PDF (até 10 MB)"
                >
                  <IconClip /> {uploading ? 'Enviando…' : 'Anexar'}
                </button>
                <div ref={toolsMenu} className="relative">
                  <button
                    onClick={() => setShowTools((v) => !v)}
                    className={`${btnGhost} gap-1.5 px-2.5 py-1.5 ${showTools ? 'bg-subtle text-fg' : ''}`}
                    aria-expanded={showTools}
                  >
                    <IconTools /> Ferramentas
                    {enabledCount > 0 && <span className="rounded-md bg-accent-soft px-1.5 text-[11px] font-semibold text-accent-ink">{enabledCount}</span>}
                  </button>
                  {showTools && (
                    <div className="absolute bottom-full left-0 z-20 mb-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface p-2 shadow-pop">
                      <div className="px-2 pb-1.5 pt-1 text-[11px] font-medium uppercase tracking-wider text-muted">Ferramentas desta conversa</div>
                      {tools.length === 0 && <div className="px-2 pb-2 text-xs text-muted">Envie uma mensagem para criar a conversa.</div>}
                      {tools.map((t) => (
                        <label
                          key={t.key}
                          className={`flex items-start gap-2.5 rounded-lg px-2 py-1.5 text-sm ${t.available ? 'cursor-pointer hover:bg-subtle' : 'opacity-50'}`}
                        >
                          <input type="checkbox" checked={t.enabled} disabled={!t.available} onChange={() => toggleTool(t)} className="mt-1 accent-[var(--accent)]" />
                          <span className="min-w-0 flex-1">
                            {t.label} <span className="text-xs text-muted">{t.kind}</span>
                            {!t.available && t.unavailableReason && <span className="block text-xs text-muted">{t.unavailableReason}</span>}
                          </span>
                        </label>
                      ))}
                      <button
                        onClick={() => setShowConnectors(true)}
                        className="mt-1 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-accent-ink hover:bg-subtle"
                      >
                        <IconPlug className="h-3.5 w-3.5" /> Gerenciar conectores
                      </button>
                    </div>
                  )}
                </div>
                <div className="ml-auto">
                  {run ? (
                    <button
                      onClick={cancel}
                      aria-label="Cancelar"
                      title="Cancelar resposta"
                      className="flex h-9 w-9 items-center justify-center rounded-xl border border-line bg-surface text-fg transition-colors hover:bg-subtle"
                    >
                      <IconStop />
                    </button>
                  ) : (
                    <button
                      onClick={send}
                      disabled={!draft.trim() || uploading}
                      aria-label="Enviar"
                      title="Enviar (Enter)"
                      className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-accent-fg transition-colors hover:bg-accent-hover disabled:opacity-40"
                    >
                      <IconSend />
                    </button>
                  )}
                </div>
              </div>
            </div>
            {error && <p className="px-1 text-sm text-danger">{error}</p>}
            <p className="hidden text-center text-[11px] text-muted sm:block">
              Enter envia · Shift+Enter quebra linha · respostas podem conter erros; confira as fontes.
            </p>
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
