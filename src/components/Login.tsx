'use client';

import { useState } from 'react';
import { IconActivity, IconLock, IconPlug } from './icons';
import { Wordmark } from './brand';
import { btnPrimary, btnSecondary, ErrorText } from './ui';

const FEATURES = [
  { icon: IconActivity, title: 'Execução inspecionável', text: 'Etapas, ferramentas, fontes e consumo de cada resposta.' },
  { icon: IconPlug, title: 'Suas fontes', text: 'Anexos, web, Drive, Gmail e servidores MCP, com citações.' },
  { icon: IconLock, title: 'Dados protegidos', text: 'Política contra vazamento e auditoria de cada ação.' },
];

export function Login() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function startDemo() {
    setBusy(true);
    setError(null);
    const res = await fetch('/api/auth/demo', { method: 'POST' });
    if (res.ok) window.location.reload();
    else {
      const body = await res.json().catch(() => null);
      setError(body?.error?.message ?? 'não foi possível iniciar a demo');
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <h1 aria-label="Chat Tess">
            <Wordmark size={40} />
          </h1>
          <p className="mt-4 text-muted">Chat com execução inspecionável: cada resposta mostra suas fontes e etapas.</p>
        </div>

        <div className="rounded-2xl border border-line bg-surface p-6 shadow-card">
          <div className="flex flex-col gap-2.5">
            <a href="/api/auth/google" className={`${btnPrimary} py-2.5`}>
              Entrar com Google
            </a>
            <button onClick={startDemo} disabled={busy} className={`${btnSecondary} py-2.5`}>
              {busy ? 'Criando sessão…' : 'Experimentar demo'}
            </button>
          </div>
          <p className="mt-3 text-center text-xs text-muted">A demo cria um usuário isolado com cota reduzida.</p>
          {error && <div className="mt-3"><ErrorText>{error}</ErrorText></div>}
        </div>

        <ul className="mt-8 space-y-4">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <li key={title} className="flex gap-3">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-ink">
                <Icon />
              </span>
              <div>
                <div className="text-sm font-medium">{title}</div>
                <div className="text-sm text-muted">{text}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
