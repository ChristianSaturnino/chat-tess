import type { Metadata } from 'next';
import { Markdown } from '@/components/Markdown';
import { resolveShare } from '@/server/sharing/shares';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Conversa compartilhada · Chat Tess',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

const credits = (micro: number) => (micro / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 });

export default async function SharedConversation({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const resolved = await resolveShare(token);
  if (!resolved) {
    return (
      <main className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-xl font-semibold">Link indisponível</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">O compartilhamento não existe, expirou ou foi revogado.</p>
      </main>
    );
  }
  const { projection, share } = resolved;
  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">
      <header className="border-b border-[var(--border)] pb-3">
        <h1 className="text-lg font-semibold">{projection.title ?? 'Conversa compartilhada'}</h1>
        <p className="text-xs text-[var(--muted)]">
          {share.mode === 'snapshot' ? `Snapshot de ${share.createdAt.toLocaleString('pt-BR')}` : 'Compartilhamento live: inclui mensagens novas'}
          {share.expiresAt && ` · expira em ${share.expiresAt.toLocaleDateString('pt-BR')}`}
          {' · '}somente leitura
        </p>
      </header>
      {projection.messages.map((m) => (
        <article key={m.seq} className={m.role === 'user' ? 'flex flex-col items-end' : ''}>
          {m.attachments.length > 0 && (
            <div className="mb-1 flex flex-wrap justify-end gap-1">
              {m.attachments.map((a) =>
                share.allowedAttachmentIds.includes(a.id) ? (
                  <a key={a.id} href={`/api/s/${token}/attachments/${a.id}`} target="_blank" rel="noopener noreferrer" className="rounded border border-[var(--border)] px-2 py-0.5 text-xs">
                    📎 {a.filename}
                  </a>
                ) : (
                  <span key={a.id} className="rounded border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--muted)]">📎 {a.filename} (não publicado)</span>
                ),
              )}
            </div>
          )}
          {m.role === 'user' ? (
            <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-[var(--accent)] px-4 py-2 text-white">{m.contentText}</div>
          ) : (
            <Markdown text={m.contentText} />
          )}
          {m.sources.length > 0 && (
            <ul className="mt-2 space-y-0.5 rounded-md border border-[var(--border)] p-2 text-xs">
              {m.sources.map((s) => (
                <li key={s.label} className={`truncate ${s.cited ? '' : 'text-[var(--muted)]'}`}>
                  <span className="font-mono">[{s.label}]</span> {s.kind}{' '}
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="underline">{s.title ?? s.url}</a>
                  ) : (
                    <span>{s.title ?? '(sem título)'}</span>
                  )}
                  {!s.cited && ' · consultada'}
                </li>
              ))}
            </ul>
          )}
          {m.execution && (
            <details className="mt-1 text-xs text-[var(--muted)]">
              <summary>Execução · {m.execution.steps.length} etapas · {credits(m.execution.costMicro)} créditos</summary>
              <ol className="mt-1 space-y-0.5">
                {m.execution.steps.map((s, i) => (
                  <li key={i}>
                    {s.kind === 'llm_call' ? 'Chamada ao modelo' : s.kind === 'compaction' ? 'Compactação de contexto' : `Ferramenta ${s.name ?? ''}`} · {s.status}
                    {s.durationMs !== null && ` · ${(s.durationMs / 1000).toFixed(1)} s`}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </article>
      ))}
      <footer className="border-t border-[var(--border)] pt-3 text-xs text-[var(--muted)]">
        Referências a Drive, Gmail e anexos indicam materiais consultados; não dão acesso aos originais.
      </footer>
    </main>
  );
}
