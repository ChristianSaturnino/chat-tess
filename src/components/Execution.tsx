'use client';

import { useEffect, useState } from 'react';
import type { MessageDto, RunEventDto } from '@/shared/events';
import { api } from './api';
import { credits, Drawer, seconds } from './ui';

type P = Record<string, any>;

/** Linha legível de um evento persistido; deltas de texto não entram na timeline. */
export function describeEvent(e: RunEventDto): string | null {
  const p = e.payload as P;
  switch (e.type) {
    case 'run_queued':
      return 'Na fila';
    case 'run_started':
      return p.resumed ? `Retomado por outro worker (versão ${p.version})` : 'Execução iniciada';
    case 'compaction_started':
      return `Compactando ${p.messages} mensagens antigas (~${p.tokensBefore} tokens)${p.forced ? ' após rejeição por contexto longo' : ''}`;
    case 'compaction_completed':
      return `Memória v${p.version}: mensagens até #${p.cutoffSeq} resumidas (~${p.tokensBefore} → ~${p.tokensAfter} tokens) · ${credits(p.costMicro)} créditos`;
    case 'compaction_failed':
      return `Compactação falhou (contexto anterior mantido): ${p.error.message}`;
    case 'attempt_started':
      return `Chamada ao modelo ${p.model} (tentativa ${p.attemptNo}${p.summaryVersion ? `, memória v${p.summaryVersion}` : ''}) · reserva ${credits(p.reservedMicro)} créditos`;
    case 'attempt_completed':
      return `Modelo respondeu em ${seconds(p.durationMs)} · ${p.usage.inputTokens} tokens de entrada (${p.usage.cachedInputTokens} em cache) / ${p.usage.outputTokens} de saída · ${credits(p.costMicro)} créditos`;
    case 'attempt_failed':
      return `Tentativa falhou: ${p.error.message}${p.retrying ? ' (nova tentativa)' : ''} · cobrança ${p.billing === 'released' ? 'liberada' : 'desconhecida, reserva mantida'}`;
    case 'attempt_interrupted':
      return 'Tentativa interrompida por queda do worker · consumo desconhecido, reserva mantida';
    case 'web_search':
      return p.status === 'searching' ? 'Buscando na web…' : 'Busca na web concluída';
    case 'tool_calls_requested':
      return `Modelo pediu ${p.calls.length} ferramenta(s): ${p.calls.map((c: P) => c.name).join(', ')}`;
    case 'tool_call_started':
      return `Ferramenta ${p.name} ${p.arguments}`;
    case 'tool_call_completed': {
      const status = { completed: 'ok', failed: 'falhou', blocked: 'bloqueada', unknown: 'resultado desconhecido' }[p.status as string];
      return `→ ${p.name}: ${status} em ${p.durationMs} ms${p.sourceLabels.length ? ` · fontes ${p.sourceLabels.join(', ')}` : ''}${p.error ? ` · ${p.error.message}` : ''}`;
    }
    case 'policy_blocked':
      return `Política bloqueou ${p.name}: ${p.message}`;
    case 'policy_restricted':
      return `Política: ${p.message}`;
    case 'cancel_requested':
      return 'Cancelamento solicitado';
    case 'run_completed':
      return `Concluído · total ${credits(p.costMicro)} créditos`;
    case 'run_failed':
      return `Falhou: ${p.error.message}`;
    case 'run_cancelled':
      return 'Cancelado';
    case 'run_interrupted':
      return `Interrompido: ${p.error.message}`;
    default:
      return null;
  }
}

export function ExecutionFooter({ execution, onOpen }: { execution: NonNullable<MessageDto['execution']>; onOpen: () => void }) {
  const parts = [
    `${execution.llmCalls} chamada${execution.llmCalls === 1 ? '' : 's'} ao modelo`,
    execution.toolCalls ? `${execution.toolCalls} ferramenta${execution.toolCalls === 1 ? '' : 's'}` : null,
    execution.compactions ? 'compactação' : null,
    `${credits(execution.costMicro)} créditos`,
    seconds(execution.durationMs),
  ].filter(Boolean);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
      <button onClick={onOpen} className="underline">Ver execução</button>
      <span>{parts.join(' · ')}</span>
    </div>
  );
}

type Timeline = {
  run: { id: string; traceId: string; model: string; tools: string[]; status: string; durationMs: number | null; costMicro: number; inputTokens: number; outputTokens: number; error: { message: string } | null };
  events: RunEventDto[];
  toolCalls: { callId: string; name: string; status: string; arguments: Record<string, unknown>; resultPreview: string | null; error: { message: string } | null; durationMs: number | null; sideEffect: boolean }[];
};

export function ExecutionPanel({ runId, onClose }: { runId: string; onClose: () => void }) {
  const [data, setData] = useState<Timeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Timeline>(`/api/runs/${runId}/timeline`).then(setData, (e) => setError(e.message));
  }, [runId]);

  return (
    <Drawer title="Execução" onClose={onClose}>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {!data && !error && <p className="text-sm text-[var(--muted)]">Carregando…</p>}
      {data && (
        <div className="space-y-4 text-sm">
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <dt className="text-[var(--muted)]">Status</dt><dd>{data.run.status}</dd>
            <dt className="text-[var(--muted)]">Modelo</dt><dd>{data.run.model}</dd>
            <dt className="text-[var(--muted)]">Duração</dt><dd>{seconds(data.run.durationMs)}</dd>
            <dt className="text-[var(--muted)]">Tokens</dt><dd>{data.run.inputTokens} entrada / {data.run.outputTokens} saída</dd>
            <dt className="text-[var(--muted)]">Consumo confirmado</dt><dd>{credits(data.run.costMicro)} créditos</dd>
            <dt className="text-[var(--muted)]">Ferramentas habilitadas</dt><dd className="break-words">{data.run.tools.join(', ') || 'nenhuma'}</dd>
            <dt className="text-[var(--muted)]">Trace</dt><dd className="truncate font-mono">{data.run.traceId}</dd>
          </dl>
          <section>
            <h3 className="mb-1 font-medium">Linha do tempo</h3>
            <ol className="space-y-1 text-xs">
              {data.events.map((e) => {
                const text = describeEvent(e);
                return text ? (
                  <li key={e.seq} className="break-words">
                    <span className="mr-1 text-[var(--muted)]">{new Date(e.createdAt).toLocaleTimeString('pt-BR')}</span>
                    {text}
                  </li>
                ) : null;
              })}
            </ol>
          </section>
          {data.toolCalls.length > 0 && (
            <section>
              <h3 className="mb-1 font-medium">Ferramentas</h3>
              <div className="space-y-2">
                {data.toolCalls.map((c) => (
                  <details key={c.callId} className="rounded border border-[var(--border)] p-2 text-xs">
                    <summary>
                      {c.name} · {c.status} · {c.durationMs ?? '—'} ms{c.sideEffect ? ' · efeito externo' : ''}
                    </summary>
                    <div className="mt-1 text-[var(--muted)]">Argumentos</div>
                    <pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(c.arguments, null, 2)}</pre>
                    {c.error && <p className="mt-1 text-red-600">{c.error.message}</p>}
                    {c.resultPreview && (
                      <>
                        <div className="mt-1 text-[var(--muted)]">Resultado (prévia)</div>
                        <pre className="max-h-48 overflow-auto whitespace-pre-wrap">{c.resultPreview}</pre>
                      </>
                    )}
                  </details>
                ))}
              </div>
            </section>
          )}
          <p className="text-xs text-[var(--muted)]">A timeline mostra ações observáveis (chamadas, ferramentas, fontes, consumo), não o raciocínio interno do modelo.</p>
        </div>
      )}
    </Drawer>
  );
}
