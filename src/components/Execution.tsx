'use client';

import { useEffect, useState } from 'react';
import type { MessageDto, RunEventDto } from '@/shared/events';
import { api } from './api';
import { IconActivity } from './icons';
import { Badge, credits, Drawer, label, seconds } from './ui';

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
    <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted">
      <button
        onClick={onOpen}
        className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-0.5 font-medium text-fg transition-colors hover:bg-subtle"
      >
        <IconActivity className="h-3.5 w-3.5 text-accent" /> Ver execução
      </button>
      <span>{parts.join(' · ')}</span>
    </div>
  );
}

type Timeline = {
  run: { id: string; traceId: string; model: string; tools: string[]; status: string; durationMs: number | null; costMicro: number; inputTokens: number; outputTokens: number; error: { message: string } | null };
  events: RunEventDto[];
  toolCalls: { callId: string; name: string; status: string; arguments: Record<string, unknown>; resultPreview: string | null; error: { message: string } | null; durationMs: number | null; sideEffect: boolean }[];
};

const STATUS_TONE: Record<string, 'accent' | 'danger' | 'warn' | 'neutral'> = {
  completed: 'accent',
  failed: 'danger',
  blocked: 'warn',
  unknown: 'warn',
  interrupted: 'warn',
  cancelled: 'neutral',
};

const STATUS_LABEL: Record<string, string> = {
  queued: 'na fila',
  running: 'em execução',
  completed: 'concluído',
  failed: 'falhou',
  blocked: 'bloqueada',
  unknown: 'desconhecido',
  interrupted: 'interrompido',
  cancelled: 'cancelado',
};
const statusLabel = (s: string) => STATUS_LABEL[s] ?? s;

function eventTone(type: string) {
  if (type.endsWith('_failed') || type === 'run_interrupted' || type === 'attempt_interrupted') return 'bg-danger';
  if (type.startsWith('policy_')) return 'bg-warn';
  if (type === 'run_completed') return 'bg-accent';
  return 'bg-line-strong';
}

function Stat({ name, value }: { name: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-subtle px-3 py-2">
      <div className="text-[11px] text-muted">{name}</div>
      <div className="mt-0.5 truncate text-sm font-medium">{value}</div>
    </div>
  );
}

export function ExecutionPanel({ runId, onClose }: { runId: string; onClose: () => void }) {
  const [data, setData] = useState<Timeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Timeline>(`/api/runs/${runId}/timeline`).then(setData, (e) => setError(e.message));
  }, [runId]);

  return (
    <Drawer title="Execução" subtitle="Ações observáveis desta resposta, não o raciocínio interno do modelo." onClose={onClose}>
      {error && <p className="text-sm text-danger">{error}</p>}
      {!data && !error && <p className="text-sm text-muted">Carregando…</p>}
      {data && (
        <div className="space-y-6 text-sm">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat name="Status" value={<Badge tone={STATUS_TONE[data.run.status] ?? 'neutral'}>{statusLabel(data.run.status)}</Badge>} />
            <Stat name="Duração" value={seconds(data.run.durationMs)} />
            <Stat name="Consumo confirmado" value={`${credits(data.run.costMicro)} créditos`} />
            <Stat name="Modelo" value={data.run.model} />
            <Stat name="Tokens" value={`${data.run.inputTokens} / ${data.run.outputTokens}`} />
            <Stat name="Ferramentas" value={data.run.tools.length || 'nenhuma'} />
          </div>
          <div className="space-y-1 text-xs text-muted">
            <div className="break-words">Habilitadas: {data.run.tools.join(', ') || 'nenhuma'}</div>
            <div className="truncate">Trace <span className="font-mono">{data.run.traceId}</span></div>
          </div>

          <section>
            <h3 className={`${label} mb-3`}>Linha do tempo</h3>
            <ol className="relative space-y-3 border-l border-line pl-4 text-xs">
              {data.events.map((e) => {
                const text = describeEvent(e);
                return text ? (
                  <li key={e.seq} className="relative break-words">
                    <span className={`absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full ring-4 ring-[var(--surface)] ${eventTone(e.type)}`} />
                    <span className="mr-1.5 font-mono text-[11px] text-muted">{new Date(e.createdAt).toLocaleTimeString('pt-BR')}</span>
                    {text}
                  </li>
                ) : null;
              })}
            </ol>
          </section>

          {data.toolCalls.length > 0 && (
            <section>
              <h3 className={`${label} mb-2`}>Ferramentas</h3>
              <div className="space-y-2">
                {data.toolCalls.map((c) => (
                  <details key={c.callId} className="group rounded-lg border border-line text-xs">
                    <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
                      <span className="font-mono font-medium">{c.name}</span>
                      <Badge tone={STATUS_TONE[c.status] ?? 'neutral'}>{statusLabel(c.status)}</Badge>
                      {c.sideEffect && <Badge tone="warn">efeito externo</Badge>}
                      <span className="ml-auto text-muted">{c.durationMs ?? '—'} ms</span>
                    </summary>
                    <div className="space-y-2 border-t border-line px-3 py-2">
                      <div>
                        <div className="mb-1 text-muted">Argumentos</div>
                        <pre className="overflow-auto whitespace-pre-wrap rounded-md bg-subtle p-2 font-mono">{JSON.stringify(c.arguments, null, 2)}</pre>
                      </div>
                      {c.error && <p className="text-danger">{c.error.message}</p>}
                      {c.resultPreview && (
                        <div>
                          <div className="mb-1 text-muted">Resultado (prévia)</div>
                          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-subtle p-2 font-mono">{c.resultPreview}</pre>
                        </div>
                      )}
                    </div>
                  </details>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </Drawer>
  );
}
