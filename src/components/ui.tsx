'use client';

export const credits = (micro: number) => (micro / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
export const seconds = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s`);

export const btn = 'rounded border border-[var(--border)] px-2 py-1 text-xs disabled:opacity-50';
export const input = 'w-full rounded border border-[var(--border)] bg-transparent px-2 py-1 text-sm';

/** Painel lateral sobreposto; fecha ao clicar fora. */
export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-black/40" onClick={onClose}>
      <div className="h-full w-full max-w-lg overflow-y-auto bg-[var(--panel)] p-4" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className={btn}>Fechar</button>
        </div>
        {children}
      </div>
    </div>
  );
}
