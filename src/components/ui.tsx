'use client';

import { useEffect } from 'react';
import { Wordmark } from './brand';
import { IconX } from './icons';

export const credits = (micro: number) => (micro / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
export const seconds = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s`);

const base = 'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:pointer-events-none disabled:opacity-50';
export const btn = `${base} border border-line bg-surface px-2.5 py-1 text-xs text-fg hover:bg-subtle`;
export const btnPrimary = `${base} bg-accent px-3.5 py-2 text-sm text-accent-fg hover:bg-accent-hover`;
export const btnSecondary = `${base} border border-line bg-surface px-3.5 py-2 text-sm text-fg hover:bg-subtle`;
export const btnGhost = `${base} px-2 py-1 text-xs text-muted hover:bg-subtle hover:text-fg`;
export const input =
  'w-full rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-fg placeholder:text-muted transition-colors focus:border-accent focus:outline-none';
export const card = 'rounded-xl border border-line bg-surface p-3.5';
export const label = 'text-[11px] font-medium uppercase tracking-wider text-muted';

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'accent' | 'danger' | 'warn'; children: React.ReactNode }) {
  const tones = {
    neutral: 'bg-subtle text-muted',
    accent: 'bg-accent-soft text-accent-ink',
    danger: 'bg-danger-soft text-danger',
    warn: 'bg-warn-soft text-warn',
  };
  return <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

export function ErrorText({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{children}</p>;
}

/** Painel lateral sobreposto; fecha ao clicar fora ou com Esc. */
export function Drawer({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-lg flex-col border-l border-line bg-surface shadow-pop"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          <button onClick={onClose} className={`${btnGhost} -mr-1 h-8 w-8 p-0`} aria-label="Fechar">
            <IconX />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

export function PageHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-bg/85 backdrop-blur">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-3">
        <a href="/" aria-label="Chat Tess">
          <Wordmark size={18} />
        </a>
        <span className="text-line-strong">/</span>
        <h1 className="mr-auto text-sm font-medium">{title}</h1>
        {children}
      </div>
    </header>
  );
}
