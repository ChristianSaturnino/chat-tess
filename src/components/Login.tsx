'use client';

import { useState } from 'react';

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
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 px-4">
      <h1 className="text-2xl font-semibold">Chat Tess</h1>
      <p className="text-sm text-[var(--muted)]">Cada resposta tem uma execução inspecionável.</p>
      <a href="/api/auth/google" className="rounded-md bg-[var(--accent)] px-4 py-2 text-center text-white">
        Entrar com Google
      </a>
      <button onClick={startDemo} disabled={busy} className="rounded-md border border-[var(--border)] px-4 py-2 disabled:opacity-50">
        {busy ? 'Criando sessão…' : 'Experimentar demo'}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <p className="text-xs text-[var(--muted)]">A demo cria um usuário isolado com cota reduzida.</p>
    </main>
  );
}
