import type { Metadata } from 'next';
import { Markdown } from '@/components/Markdown';
import { TessAvatar, TessMark, Wordmark } from '@/components/brand';
import { Badge } from '@/components/ui';
import { resolveShare } from '@/server/sharing/shares';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Conversa compartilhada · Chat Tess',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

const credits = (micro: number) => (micro / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 });

function Brand() {
  return (
    <a href="/" aria-label="Chat Tess">
      <Wordmark size={18} />
    </a>
  );
}

export default async function SharedConversation({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const resolved = await resolveShare(token);
  if (!resolved) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center px-4 text-center">
        <TessMark size={40} />
        <h1 className="mt-5 text-xl font-semibold">Link indisponível</h1>
        <p className="mt-2 text-sm text-muted">O compartilhamento não existe, expirou ou foi revogado.</p>
      </main>
    );
  }
  const { projection, share } = resolved;
  return (
    <div className="min-h-dvh bg-surface">
      <div className="border-b border-line">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-3 sm:px-6">
          <Brand />
          <span className="ml-auto">
            <Badge>somente leitura</Badge>
          </span>
        </div>
      </div>
      <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">{projection.title ?? 'Conversa compartilhada'}</h1>
          <p className="mt-1.5 text-sm text-muted">
            {share.mode === 'snapshot' ? `Snapshot de ${share.createdAt.toLocaleString('pt-BR')}` : 'Compartilhamento live: inclui mensagens novas'}
            {share.expiresAt && ` · expira em ${share.expiresAt.toLocaleDateString('pt-BR')}`}
          </p>
        </header>
        <div className="space-y-7">
          {projection.messages.map((m) => (
            <article key={m.seq} className={m.role === 'user' ? 'flex flex-col items-end' : 'flex gap-3'}>
              {m.role === 'user' ? (
                <>
                  {m.attachments.length > 0 && (
                    <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
                      {m.attachments.map((a) =>
                        share.allowedAttachmentIds.includes(a.id) ? (
                          <a
                            key={a.id}
                            href={`/api/s/${token}/attachments/${a.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="rounded-lg border border-line px-2.5 py-1 text-xs hover:bg-subtle"
                          >
                            📎 {a.filename}
                          </a>
                        ) : (
                          <span key={a.id} className="rounded-lg border border-line px-2.5 py-1 text-xs text-muted">
                            📎 {a.filename} (não publicado)
                          </span>
                        ),
                      )}
                    </div>
                  )}
                  <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-accent-fg">{m.contentText}</div>
                </>
              ) : (
                <>
                  <div className="pt-0.5">
                    <TessAvatar size={28} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <Markdown text={m.contentText} />
                    {m.sources.length > 0 && (
                      <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
                        {m.sources.map((s) => (
                          <li
                            key={s.label}
                            className={`flex min-w-0 items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-xs ${s.cited ? '' : 'opacity-75'}`}
                          >
                            <span className="font-mono text-[11px] font-semibold text-accent-ink">{s.label}</span>
                            {s.url ? (
                              <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="truncate hover:underline">
                                {s.title ?? s.url}
                              </a>
                            ) : (
                              <span className="truncate">{s.title ?? '(sem título)'}</span>
                            )}
                            <span className="ml-auto shrink-0 text-[11px] text-muted">
                              {s.kind}
                              {!s.cited && ' · consultada'}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {m.execution && (
                      <details className="mt-3 text-xs text-muted">
                        <summary className="cursor-pointer">
                          Execução · {m.execution.steps.length} etapas · {credits(m.execution.costMicro)} créditos
                        </summary>
                        <ol className="mt-2 space-y-1 border-l-2 border-line pl-3">
                          {m.execution.steps.map((s, i) => (
                            <li key={i}>
                              {s.kind === 'llm_call' ? 'Chamada ao modelo' : s.kind === 'compaction' ? 'Compactação de contexto' : `Ferramenta ${s.name ?? ''}`} · {s.status}
                              {s.durationMs !== null && ` · ${(s.durationMs / 1000).toFixed(1)} s`}
                            </li>
                          ))}
                        </ol>
                      </details>
                    )}
                  </div>
                </>
              )}
            </article>
          ))}
        </div>
        <footer className="mt-12 border-t border-line pt-4 text-xs text-muted">
          Referências a Drive, Gmail e anexos indicam materiais consultados; não dão acesso aos originais.
        </footer>
      </main>
    </div>
  );
}
