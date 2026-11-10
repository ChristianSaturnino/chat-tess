import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  contextSummaries,
  messages,
  runSteps,
  runs,
  stepAttempts,
  toolCalls,
  usageLedger,
  type RunConfigSnapshot,
  type UsageSnapshot,
} from '@/db/schema';
import { db, withTx, type Db } from '@/db/client';
import type { ErrorDto } from '@/shared/events';
import { audit } from '../audit/audit';
import { config, type Pricing } from '../config';
import { InsufficientCreditsError, markUnknown, release, reserve, settle } from '../credits/credits';
import { costMicro, estimateInputTokens, reservationMicro } from '../credits/pricing';
import { getLlm } from '../llm';
import { LlmError, type Citation, type FunctionCall, type LlmItem, type LlmStreamEvent, type LlmToolDef } from '../llm/types';
import { logger } from '../logger';
import { appendEvent } from '../runs/events';
import { linkMessageSources, registerSources } from '../sources/sources';
import { evaluateEgress } from '../tools/policy';
import { resolveToolset } from '../tools/registry';
import { ToolError, type ToolFunction, type ToolProvider, type ToolResult } from '../tools/types';
import { chunkPrefix, EMPTY_SUMMARY, parseSummary, planCompaction, renderSummary, SUMMARIZER_PROMPT, summarizerInput } from './compactor';
import { buildContext, SYSTEM_PROMPT } from './context';

class LeaseLostError extends Error {
  constructor() {
    super('lease perdido: outro worker assumiu o run');
  }
}

class CancelRequestedError extends Error {}

type Claim = {
  runId: string;
  version: number;
  userId: string;
  conversationId: string;
  assistantMessageId: string;
  userMessageId: string;
  traceId: string;
  cfg: RunConfigSnapshot;
};

export type ExecuteResult = 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'skipped';

type StepRow = typeof runSteps.$inferSelect;

export type LlmCheckpoint = {
  text: string;
  output: LlmItem[];
  functionCalls: FunctionCall[];
  citations: Citation[];
  usage: UsageSnapshot;
  costMicro: number;
  incomplete: string | null;
};

type ToolCheckpoint = { callId: string; output: string; status: 'completed' | 'failed' | 'blocked' | 'unknown' };

type RegisteredFn = { provider: ToolProvider; fn: ToolFunction };

/**
 * Verifica, sob lock da linha do run, que este worker ainda é o dono (fencing).
 * Toda escrita do engine passa por aqui dentro da mesma transação.
 */
async function fence(tx: Db, claim: Claim) {
  const r = await tx.execute<{ version: number; cancel_requested: boolean; status: string }>(
    sql`select version, cancel_requested, status from runs where id = ${claim.runId} for update`,
  );
  const row = r.rows[0];
  if (!row || row.version !== claim.version || row.status !== 'running') throw new LeaseLostError();
  return { cancelRequested: row.cancel_requested };
}

async function claimRun(runId: string, workerId: string): Promise<{ claim: Claim; resumed: boolean; cancelRequested: boolean } | null> {
  const leaseSeconds = config().limits.leaseSeconds;
  return withTx(async ({ db: tx }) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).for('update');
    if (!run) return null;
    if (run.status !== 'queued' && run.status !== 'running') return null;
    if (run.status === 'running' && run.leaseOwner !== workerId && run.leaseExpiresAt && run.leaseExpiresAt > new Date()) {
      // Outro worker vivo detém o lease; este job é duplicado.
      return null;
    }
    const resumed = run.status === 'running';
    const [updated] = await tx
      .update(runs)
      .set({
        status: 'running',
        leaseOwner: workerId,
        leaseExpiresAt: sql`now() + make_interval(secs => ${leaseSeconds})`,
        version: sql`${runs.version} + 1`,
        startedAt: run.startedAt ?? new Date(),
      })
      .where(eq(runs.id, runId))
      .returning({ version: runs.version });
    await appendEvent(tx, runId, 'run_started', { version: updated!.version, resumed });
    return {
      resumed,
      cancelRequested: run.cancelRequested,
      claim: {
        runId,
        version: updated!.version,
        userId: run.userId,
        conversationId: run.conversationId,
        assistantMessageId: run.assistantMessageId,
        userMessageId: run.userMessageId,
        traceId: run.traceId,
        cfg: run.configSnapshot,
      },
    };
  });
}

function startHeartbeat(claim: Claim, workerId: string, onLost: () => void) {
  const { leaseSeconds, heartbeatMs } = config().limits;
  const timer = setInterval(() => {
    withTx(async ({ db: tx }) => {
      const r = await tx
        .update(runs)
        .set({ leaseExpiresAt: sql`now() + make_interval(secs => ${leaseSeconds})` })
        .where(and(eq(runs.id, claim.runId), eq(runs.version, claim.version), eq(runs.leaseOwner, workerId)))
        .returning({ id: runs.id });
      if (r.length === 0) onLost();
    }).catch((err) => logger.warn({ err, runId: claim.runId }, 'heartbeat falhou'));
  }, heartbeatMs);
  return () => clearInterval(timer);
}

type Terminal = { status: 'completed' | 'failed' | 'cancelled' | 'interrupted'; error?: ErrorDto };

async function runCostMicro(tx: Db, runId: string) {
  const [r] = await tx
    .select({ total: sql<string>`coalesce(sum(${usageLedger.costMicro}), 0)` })
    .from(usageLedger)
    .innerJoin(stepAttempts, eq(stepAttempts.id, usageLedger.attemptId))
    .innerJoin(runSteps, eq(runSteps.id, stepAttempts.stepId))
    .where(eq(runSteps.runId, runId));
  return Number(r?.total ?? 0);
}

async function finalize(tx: Db, claim: Claim, t: Terminal) {
  const msgStatus = t.status === 'completed' ? 'completed' : t.status === 'cancelled' ? 'cancelled' : 'failed';
  await tx.update(messages).set({ status: msgStatus }).where(eq(messages.id, claim.assistantMessageId));
  await tx
    .update(runs)
    .set({ status: t.status, error: t.error ?? null, finishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null })
    .where(eq(runs.id, claim.runId));
  const messageId = claim.assistantMessageId;
  if (t.status === 'completed') await appendEvent(tx, claim.runId, 'run_completed', { messageId, costMicro: await runCostMicro(tx, claim.runId) });
  else if (t.status === 'cancelled') await appendEvent(tx, claim.runId, 'run_cancelled', { messageId });
  else if (t.status === 'interrupted') await appendEvent(tx, claim.runId, 'run_interrupted', { messageId, error: t.error! });
  else await appendEvent(tx, claim.runId, 'run_failed', { messageId, error: t.error! });
  await audit(tx, {
    actorUserId: claim.userId,
    action: `run.${t.status}`,
    entityType: 'run',
    entityId: claim.runId,
    runId: claim.runId,
    traceId: claim.traceId,
    payload: t.error ? { error: t.error } : {},
  });
}

/**
 * Tentativas LLM encontradas em 'running' pertencem a um worker anterior que caiu.
 * Não sabemos se o provider processou: consumo 'unknown', reserva mantida.
 */
async function resolveOrphanAttempts(tx: Db, claim: Claim) {
  const orphans = await tx
    .select({ id: stepAttempts.id })
    .from(stepAttempts)
    .innerJoin(runSteps, eq(runSteps.id, stepAttempts.stepId))
    .where(and(eq(runSteps.runId, claim.runId), eq(stepAttempts.status, 'running')));
  for (const o of orphans) {
    await tx
      .update(stepAttempts)
      .set({ status: 'unknown', finishedAt: new Date(), error: { code: 'worker_lost', message: 'worker interrompido durante a chamada' } })
      .where(eq(stepAttempts.id, o.id));
    await markUnknown(tx, o.id);
    await appendEvent(tx, claim.runId, 'attempt_interrupted', { attemptId: o.id, billing: 'unknown' });
  }
}

const loadSteps = (d: Db, runId: string) => d.select().from(runSteps).where(eq(runSteps.runId, runId)).orderBy(asc(runSteps.seq));

const joinText = (base: string) => (base ? `${base}\n\n` : '');

export async function executeRun(runId: string, workerId: string): Promise<ExecuteResult> {
  const claimed = await claimRun(runId, workerId);
  if (!claimed) return 'skipped';
  const { claim } = claimed;
  const log = logger.child({ runId, traceId: claim.traceId, version: claim.version });
  log.info({ resumed: claimed.resumed }, 'run reivindicado');

  const abort = new AbortController();
  let leaseLost = false;
  const stopHeartbeat = startHeartbeat(claim, workerId, () => {
    leaseLost = true;
    abort.abort();
  });

  try {
    await withTx(async ({ db: tx }) => {
      await fence(tx, claim);
      await resolveOrphanAttempts(tx, claim);
    });
    if (claimed.cancelRequested) throw new CancelRequestedError();
    return await runLoop(claim, abort, () => leaseLost, log);
  } catch (err) {
    if (err instanceof LeaseLostError || leaseLost) {
      log.warn('lease perdido; encerrando sem escrever');
      return 'skipped';
    }
    if (err instanceof CancelRequestedError) {
      await withTx(async ({ db: tx }) => {
        await fence(tx, claim);
        await finalize(tx, claim, { status: 'cancelled' });
      });
      return 'cancelled';
    }
    log.error({ err }, 'erro inesperado no run');
    // Falha inesperada: o run fica 'running' com lease expirando → recuperação pelo sweeper/retry.
    throw err;
  } finally {
    stopHeartbeat();
  }
}

/** Expõe as funções do toolset com nomes únicos para o modelo. */
function registerFunctions(providers: ToolProvider[]) {
  const byName = new Map<string, RegisteredFn>();
  for (const provider of providers) {
    for (const fn of provider.functions) {
      let name = fn.name;
      for (let i = 2; byName.has(name); i++) name = `${fn.name.slice(0, 60)}_${i}`;
      byName.set(name, { provider, fn: { ...fn, name } });
    }
  }
  const defs: LlmToolDef[] = [...byName.values()].map(({ fn }) => ({ name: fn.name, description: fn.description, parameters: fn.parameters }));
  return { byName, defs };
}

async function runLoop(claim: Claim, abort: AbortController, isLeaseLost: () => boolean, log: typeof logger): Promise<ExecuteResult> {
  const limits = { ...config().limits, ...(claim.cfg.limits ?? {}) };
  const toolset = await resolveToolset(claim.userId, claim.cfg.tools ?? []);
  const { byName, defs } = registerFunctions(toolset.providers);
  const webSearch = toolset.webSearch && claim.cfg.webSearch ? claim.cfg.webSearch : null;

  let forcedCompaction = false;
  try {
    for (;;) {
      let steps = await loadSteps(db(), claim.runId);
      if (!steps.some((s) => s.kind === 'llm_call') && !steps.some((s) => s.kind === 'compaction' && s.status !== 'running')) {
        await compactionStep(claim, abort, log, false);
        steps = await loadSteps(db(), claim.runId);
      }
      const llmSteps = steps.filter((s) => s.kind === 'llm_call');
      const lastLlm = llmSteps.at(-1);

      if (lastLlm?.status === 'completed') {
        const cp = lastLlm.checkpoint as unknown as LlmCheckpoint;
        const done = new Set(
          steps
            .filter((s) => s.kind === 'tool_call' && s.status !== 'running')
            .map((s) => (s.checkpoint as unknown as ToolCheckpoint | null)?.callId),
        );
        const pending = cp.functionCalls.filter((c) => !done.has(c.callId));
        if (cp.functionCalls.length === 0) {
          // Etapa final já confirmada (queda entre checkpoint e finalização): conclui sem nova chamada.
          await withTx(async ({ db: tx }) => {
            await fence(tx, claim);
            await finalize(tx, claim, { status: 'completed' });
          });
          return 'completed';
        }
        if (pending.length) {
          await runTools(claim, pending, steps, byName, abort, limits);
          continue;
        }
      }

      const completedLlm = llmSteps.filter((s) => s.status === 'completed');
      if (lastLlm?.status === 'completed' && completedLlm.length >= limits.maxIterations) {
        await withTx(async ({ db: tx }) => {
          await fence(tx, claim);
          await finalize(tx, claim, { status: 'failed', error: { code: 'max_iterations', message: `limite de ${limits.maxIterations} etapas atingido` } });
        });
        return 'failed';
      }

      const seq = lastLlm && lastLlm.status !== 'completed' ? lastLlm.seq : (steps.at(-1)?.seq ?? 0) + 1;
      const result = await llmStep(claim, seq, steps, defs, webSearch, abort, isLeaseLost, log, !forcedCompaction);
      if (result === 'compact') {
        // Provider rejeitou por contexto longo: uma compactação forçada e uma nova tentativa, sem loop.
        forcedCompaction = true;
        if (!(await compactionStep(claim, abort, log, true))) {
          await withTx(async ({ db: tx }) => {
            await fence(tx, claim);
            await finalize(tx, claim, { status: 'failed', error: { code: 'context_too_long', message: 'o contexto excede o limite do modelo e não pôde ser compactado' } });
          });
          return 'failed';
        }
        continue;
      }
      if (result !== 'continue') return result;
    }
  } finally {
    await toolset.close().catch(() => {});
  }
}

/** Itens do próprio run (saídas do modelo e resultados de tools) a reenviar na próxima chamada. */
function runItems(steps: StepRow[]): { items: LlmItem[]; baseText: string; chars: number } {
  const items: LlmItem[] = [];
  const texts: string[] = [];
  let chars = 0;
  const toolOutput = new Map<string, string>();
  for (const s of steps) {
    if (s.kind === 'tool_call' && s.status !== 'running' && s.checkpoint) {
      const cp = s.checkpoint as unknown as ToolCheckpoint;
      toolOutput.set(cp.callId, cp.output);
    }
  }
  for (const s of steps) {
    if (s.kind !== 'llm_call' || s.status !== 'completed') continue;
    const cp = s.checkpoint as unknown as LlmCheckpoint;
    items.push(...cp.output);
    if (cp.text) texts.push(cp.text);
    for (const c of cp.functionCalls) {
      const output = toolOutput.get(c.callId) ?? 'resultado indisponível';
      items.push({ kind: 'function_call_output', callId: c.callId, output });
      chars += output.length + c.arguments.length;
    }
  }
  return { items, baseText: texts.join('\n\n'), chars };
}

async function llmStep(
  claim: Claim,
  seq: number,
  steps: StepRow[],
  toolDefs: LlmToolDef[],
  webSearch: { maxCalls: number; feeMicroPerCall: number; tokensPerCall?: number } | null,
  abort: AbortController,
  isLeaseLost: () => boolean,
  log: typeof logger,
  canForceCompaction: boolean,
): Promise<ExecuteResult | 'continue' | 'compact'> {
  const cfg = claim.cfg;
  const limits = config().limits;
  const pricing: Pricing = { ...config().llm.pricing, version: cfg.pricingVersion };
  const llm = getLlm(cfg.provider);
  const prior = runItems(steps);
  const base = joinText(prior.baseText);

  for (;;) {
    let prepared: { id: string; stepId: string; attemptNo: number; input: LlmItem[] } | null;
    try {
      prepared = await withTx(async ({ db: tx }) => {
        if ((await fence(tx, claim)).cancelRequested) throw new CancelRequestedError();
        const [userMsg] = await tx.select({ seq: messages.seq }).from(messages).where(eq(messages.id, claim.userMessageId));
        const ctx = await buildContext(tx, { id: claim.runId, userId: claim.userId, conversationId: claim.conversationId }, userMsg!.seq);
        const input = [...ctx.items, ...prior.items];

        let [step] = await tx.select().from(runSteps).where(and(eq(runSteps.runId, claim.runId), eq(runSteps.seq, seq)));
        step ??= (await tx.insert(runSteps).values({ runId: claim.runId, seq, kind: 'llm_call', status: 'running' }).returning())[0]!;

        const [{ n }] = (await tx.select({ n: sql<number>`count(*)::int` }).from(stepAttempts).where(eq(stepAttempts.stepId, step.id))) as [{ n: number }];
        const attemptNo = n + 1;
        if (attemptNo > cfg.maxLlmAttempts) return null;

        const [att] = await tx
          .insert(stepAttempts)
          .values({ stepId: step.id, attemptNo, status: 'running', runVersion: claim.version, model: cfg.model })
          .returning({ id: stepAttempts.id });

        const schemaChars = JSON.stringify(toolDefs).length;
        const reservedMicro = reservationMicro(
          {
            inputChars: SYSTEM_PROMPT.length + ctx.estimatedChars + prior.chars + schemaChars,
            extraInputTokens: ctx.extraTokens,
            maxOutputTokens: cfg.maxOutputTokens,
            webSearch,
          },
          pricing,
        );
        await reserve(tx, { userId: claim.userId, attemptId: att!.id, amountMicro: reservedMicro });

        // Nova geração substitui explicitamente qualquer texto parcial desta etapa.
        await tx.update(messages).set({ status: 'streaming', contentText: base }).where(eq(messages.id, claim.assistantMessageId));
        await appendEvent(tx, claim.runId, 'attempt_started', {
          attemptId: att!.id,
          stepId: step.id,
          attemptNo,
          model: cfg.model,
          reservedMicro,
          messageId: claim.assistantMessageId,
          baseText: base,
          summaryVersion: ctx.summaryVersion,
        });
        return { id: att!.id, stepId: step.id, attemptNo, input };
      });
      if (!prepared) {
        await withTx(async ({ db: tx }) => {
          await fence(tx, claim);
          await finalize(tx, claim, {
            status: 'interrupted',
            error: { code: 'attempts_exhausted', message: 'limite de tentativas atingido após falhas/interrupções' },
          });
        });
        return 'interrupted';
      }
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        await withTx(async ({ db: tx }) => {
          await fence(tx, claim);
          await finalize(tx, claim, {
            status: 'failed',
            error: { code: 'insufficient_credits', message: err.scope === 'global' ? 'limite global de consumo atingido' : 'saldo de créditos insuficiente' },
          });
        });
        return 'failed';
      }
      throw err;
    }

    // Nenhuma transação fica aberta durante a chamada de rede.
    const attempt = prepared;
    const started = Date.now();
    let text = '';
    let pending = '';
    let lastFlush = Date.now();
    let cancelled = false;
    let requestId: string | undefined;

    const flush = async () => {
      if (!pending) return;
      const chunk = pending;
      pending = '';
      lastFlush = Date.now();
      await withTx(async ({ db: tx }) => {
        const f = await fence(tx, claim);
        await tx.update(messages).set({ contentText: base + text }).where(eq(messages.id, claim.assistantMessageId));
        await appendEvent(tx, claim.runId, 'text_delta', { attemptId: attempt.id, messageId: claim.assistantMessageId, text: chunk });
        if (f.cancelRequested && !cancelled) {
          cancelled = true;
          abort.abort();
        }
      });
    };

    // Cancelamento também é observado sem deltas (ex.: modelo pensando ou buscando).
    const cancelPoll = setInterval(() => {
      db()
        .select({ c: runs.cancelRequested })
        .from(runs)
        .where(eq(runs.id, claim.runId))
        .then(([r]) => {
          if (r?.c && !cancelled) {
            cancelled = true;
            abort.abort();
          }
        })
        .catch(() => {});
    }, 1000);

    let outcome: { kind: 'ok'; ev: Extract<LlmStreamEvent, { type: 'completed' }> } | { kind: 'error'; error: LlmError };
    const nextCompleted = async () => {
      for await (const ev of llm.stream({
        model: cfg.model,
        instructions: SYSTEM_PROMPT,
        input: attempt.input,
        tools: toolDefs,
        webSearch: webSearch ? { maxCalls: webSearch.maxCalls } : null,
        maxOutputTokens: cfg.maxOutputTokens,
        signal: abort.signal,
      })) {
        if (ev.type === 'request_id') requestId = ev.id;
        else if (ev.type === 'text_delta') {
          text += ev.text;
          pending += ev.text;
          if (pending.length >= limits.deltaFlushChars || Date.now() - lastFlush >= limits.deltaFlushMs) await flush();
        } else if (ev.type === 'web_search') {
          await withTx(async ({ db: tx }) => {
            await fence(tx, claim);
            await appendEvent(tx, claim.runId, 'web_search', { attemptId: attempt.id, itemId: ev.itemId, status: ev.status });
          });
        } else if (ev.type === 'completed') {
          return ev;
        }
      }
      return null;
    };
    try {
      const ev = await nextCompleted();
      outcome = ev ? { kind: 'ok', ev } : { kind: 'error', error: new LlmError('stream_ended', 'stream encerrado sem conclusão', 'unknown', true) };
    } catch (err) {
      if (err instanceof LeaseLostError) throw err;
      outcome = {
        kind: 'error',
        error: err instanceof LlmError ? err : new LlmError('unexpected', err instanceof Error ? err.message : String(err), 'unknown', false),
      };
    } finally {
      clearInterval(cancelPoll);
    }
    if (isLeaseLost()) throw new LeaseLostError();

    if (outcome.kind === 'ok' && !cancelled) {
      const ev = outcome.ev;
      const tokenCost = costMicro(ev.usage, pricing);
      const toolFee = webSearch ? ev.webSearchCalls * webSearch.feeMicroPerCall : 0;
      const cost = tokenCost + toolFee;
      const durationMs = Date.now() - started;
      const incomplete = ev.status === 'incomplete' ? (ev.incompleteReason ?? 'incomplete') : null;
      const isFinal = ev.functionCalls.length === 0;
      const checkpoint: LlmCheckpoint = {
        text,
        output: ev.output,
        functionCalls: ev.functionCalls,
        citations: ev.citations,
        usage: ev.usage,
        costMicro: cost,
        incomplete,
      };
      await withTx(async ({ db: tx }) => {
        await fence(tx, claim);
        if (pending) {
          await appendEvent(tx, claim.runId, 'text_delta', { attemptId: attempt.id, messageId: claim.assistantMessageId, text: pending });
          pending = '';
        }
        await tx.update(messages).set({ contentText: (base + text).trim() }).where(eq(messages.id, claim.assistantMessageId));
        await settle(tx, {
          attemptId: attempt.id,
          userId: claim.userId,
          model: cfg.model,
          pricingVersion: pricing.version,
          usage: ev.usage,
          webSearchCalls: ev.webSearchCalls,
          toolFeeMicro: toolFee,
          costMicro: cost,
        });
        await tx
          .update(stepAttempts)
          .set({ status: 'completed', usage: ev.usage, providerRequestId: requestId ?? null, finishedAt: new Date() })
          .where(eq(stepAttempts.id, attempt.id));
        await tx
          .update(runSteps)
          .set({ status: 'completed', finishedAt: new Date(), checkpoint: checkpoint as unknown as Record<string, unknown> })
          .where(eq(runSteps.id, attempt.stepId));
        if (ev.citations.length) {
          await registerSources(
            tx,
            claim.runId,
            claim.userId,
            ev.citations.map((c) => ({ kind: 'web' as const, ref: c.url, url: c.url, title: c.title })),
          );
        }
        await appendEvent(tx, claim.runId, 'attempt_completed', { attemptId: attempt.id, usage: ev.usage, costMicro: cost, durationMs });
        if (!isFinal) {
          await appendEvent(tx, claim.runId, 'tool_calls_requested', {
            stepId: attempt.stepId,
            calls: ev.functionCalls.map((c) => ({ callId: c.callId, name: c.name })),
          });
        }
        await audit(tx, {
          actorUserId: claim.userId,
          action: 'llm.call',
          entityType: 'step_attempt',
          entityId: attempt.id,
          runId: claim.runId,
          traceId: claim.traceId,
          payload: { model: cfg.model, usage: ev.usage, costMicro: cost, webSearchCalls: ev.webSearchCalls, durationMs, incomplete, toolCalls: ev.functionCalls.length },
        });
        if (isFinal) {
          const finalText = (base + text).trim();
          const allCitations = [...steps.flatMap((s) => (s.kind === 'llm_call' && s.checkpoint ? ((s.checkpoint as unknown as LlmCheckpoint).citations ?? []) : [])), ...ev.citations];
          await linkMessageSources(tx, claim.runId, claim.assistantMessageId, finalText, allCitations.map((c) => c.url));
          await finalize(tx, claim, { status: 'completed' });
        }
      });
      log.info({ costMicro: cost, durationMs, toolCalls: ev.functionCalls.length }, 'etapa LLM concluída');
      return isFinal ? 'completed' : 'continue';
    }

    const error = outcome.kind === 'error' ? outcome.error : new LlmError('cancelled', 'cancelado', 'unknown', false);
    if (cancelled) {
      await withTx(async ({ db: tx }) => {
        await fence(tx, claim);
        if (pending) {
          await appendEvent(tx, claim.runId, 'text_delta', { attemptId: attempt.id, messageId: claim.assistantMessageId, text: pending });
        }
        await tx.update(messages).set({ contentText: base + text }).where(eq(messages.id, claim.assistantMessageId));
        await tx
          .update(stepAttempts)
          .set({ status: 'cancelled', providerRequestId: requestId ?? null, finishedAt: new Date() })
          .where(eq(stepAttempts.id, attempt.id));
        // Abortar o stream não devolve usage: consumo já ocorrido fica 'unknown', reserva mantida.
        await markUnknown(tx, attempt.id);
        await appendEvent(tx, claim.runId, 'attempt_failed', {
          attemptId: attempt.id,
          error: { code: 'cancelled', message: 'cancelado pelo usuário' },
          billing: 'unknown',
          retrying: false,
        });
        await tx.update(runSteps).set({ status: 'failed', finishedAt: new Date() }).where(eq(runSteps.id, attempt.stepId));
        await finalize(tx, claim, { status: 'cancelled' });
      });
      return 'cancelled';
    }

    const recoverContext = error.code === 'context_too_long' && canForceCompaction && attempt.attemptNo < cfg.maxLlmAttempts;
    const retrying = (error.retryable || recoverContext) && attempt.attemptNo < cfg.maxLlmAttempts;
    const errDto = { code: error.code, message: error.message.slice(0, 500) };
    await withTx(async ({ db: tx }) => {
      await fence(tx, claim);
      await tx
        .update(stepAttempts)
        .set({ status: error.billing === 'unknown' ? 'unknown' : 'failed', error: errDto, providerRequestId: requestId ?? null, finishedAt: new Date() })
        .where(eq(stepAttempts.id, attempt.id));
      if (error.billing === 'not_billed') await release(tx, attempt.id);
      else await markUnknown(tx, attempt.id);
      await appendEvent(tx, claim.runId, 'attempt_failed', {
        attemptId: attempt.id,
        error: errDto,
        billing: error.billing === 'not_billed' ? 'released' : 'unknown',
        retrying,
      });
      await audit(tx, {
        actorUserId: claim.userId,
        action: 'llm.call_failed',
        entityType: 'step_attempt',
        entityId: attempt.id,
        runId: claim.runId,
        traceId: claim.traceId,
        payload: { error: errDto, billing: error.billing },
      });
      if (!retrying) {
        await tx.update(runSteps).set({ status: 'failed', error: errDto, finishedAt: new Date() }).where(eq(runSteps.id, attempt.stepId));
        await finalize(tx, claim, { status: 'failed', error: errDto });
      }
    });
    log.warn({ error: errDto, retrying }, 'tentativa LLM falhou');
    if (recoverContext) return 'compact';
    if (!retrying) return 'failed';
  }
}

/**
 * Etapa de compactação: resume o prefixo do histórico em memória estruturada versionada.
 * A nova versão só passa a valer depois de persistida; falha mantém o contexto anterior.
 * Devolve true se uma nova memória foi gravada.
 */
async function compactionStep(claim: Claim, abort: AbortController, log: typeof logger, force: boolean): Promise<boolean> {
  const cfg = claim.cfg;
  if (!cfg.compaction && !force) return false;
  const [userMsg] = await db().select({ seq: messages.seq }).from(messages).where(eq(messages.id, claim.userMessageId));
  const plan = await planCompaction(db(), claim.conversationId, userMsg!.seq, {
    triggerTokens: cfg.compaction?.triggerTokens ?? Number.MAX_SAFE_INTEGER,
    keepTurns: cfg.compaction?.keepTurns ?? config().limits.compactionKeepTurns,
    force,
  });
  if (!plan) return false;

  const pricing: Pricing = { ...config().llm.pricing, version: cfg.pricingVersion };
  const llm = getLlm(cfg.provider);
  const maxOutputTokens = 1_500;

  const stepId = await withTx(async ({ db: tx }) => {
    await fence(tx, claim);
    // Compactação interrompida por queda anterior: encerrada e refeita do zero.
    await tx
      .update(runSteps)
      .set({ status: 'failed', finishedAt: new Date(), error: { code: 'worker_lost', message: 'compactação interrompida' } })
      .where(and(eq(runSteps.runId, claim.runId), eq(runSteps.kind, 'compaction'), eq(runSteps.status, 'running')));
    const [{ maxSeq }] = (await tx
      .select({ maxSeq: sql<number>`coalesce(max(${runSteps.seq}), 0)::int` })
      .from(runSteps)
      .where(eq(runSteps.runId, claim.runId))) as [{ maxSeq: number }];
    const [step] = await tx.insert(runSteps).values({ runId: claim.runId, seq: maxSeq + 1, kind: 'compaction', status: 'running' }).returning();
    await appendEvent(tx, claim.runId, 'compaction_started', {
      cutoffSeq: plan.cutoffSeq,
      messages: plan.prefix.length,
      tokensBefore: plan.tokensBefore,
      previousVersion: plan.previous?.version ?? null,
      forced: force,
    });
    return step!.id;
  });

  let summary = plan.previous?.summary ?? EMPTY_SUMMARY;
  let totalCost = 0;
  try {
    for (const chunk of chunkPrefix(plan.prefix)) {
      const input = summarizerInput(summary, chunk);
      const inputChars = SUMMARIZER_PROMPT.length + JSON.stringify(input).length;
      const attemptId = await withTx(async ({ db: tx }) => {
        if ((await fence(tx, claim)).cancelRequested) throw new CancelRequestedError();
        const [{ n }] = (await tx.select({ n: sql<number>`count(*)::int` }).from(stepAttempts).where(eq(stepAttempts.stepId, stepId))) as [{ n: number }];
        const [att] = await tx
          .insert(stepAttempts)
          .values({ stepId, attemptNo: n + 1, status: 'running', runVersion: claim.version, model: cfg.model })
          .returning({ id: stepAttempts.id });
        await reserve(tx, { userId: claim.userId, attemptId: att!.id, amountMicro: reservationMicro({ inputChars, maxOutputTokens }, pricing) });
        return att!.id;
      });

      let text = '';
      let usage: UsageSnapshot | null = null;
      try {
        for await (const ev of llm.stream({
          model: cfg.model,
          instructions: SUMMARIZER_PROMPT,
          input,
          tools: [],
          webSearch: null,
          maxOutputTokens,
          signal: abort.signal,
        })) {
          if (ev.type === 'text_delta') text += ev.text;
          else if (ev.type === 'completed') usage = ev.usage;
        }
        if (!usage) throw new LlmError('stream_ended', 'stream encerrado sem conclusão', 'unknown', false);
      } catch (err) {
        const e = err instanceof LlmError ? err : new LlmError('unexpected', err instanceof Error ? err.message : String(err), 'unknown', false);
        await withTx(async ({ db: tx }) => {
          await fence(tx, claim);
          await tx
            .update(stepAttempts)
            .set({ status: e.billing === 'unknown' ? 'unknown' : 'failed', error: { code: e.code, message: e.message.slice(0, 500) }, finishedAt: new Date() })
            .where(eq(stepAttempts.id, attemptId));
          if (e.billing === 'not_billed') await release(tx, attemptId);
          else await markUnknown(tx, attemptId);
        });
        throw e;
      }
      const cost = costMicro(usage, pricing);
      totalCost += cost;
      const settledUsage = usage;
      await withTx(async ({ db: tx }) => {
        await fence(tx, claim);
        await settle(tx, { attemptId, userId: claim.userId, model: cfg.model, pricingVersion: pricing.version, usage: settledUsage, costMicro: cost });
        await tx.update(stepAttempts).set({ status: 'completed', usage: settledUsage, finishedAt: new Date() }).where(eq(stepAttempts.id, attemptId));
      });
      summary = parseSummary(text);
    }

    const tokensAfter = estimateInputTokens(renderSummary(summary).length);
    await withTx(async ({ db: tx }) => {
      await fence(tx, claim);
      const version = (plan.previous?.version ?? 0) + 1;
      await tx.insert(contextSummaries).values({
        conversationId: claim.conversationId,
        version,
        previousId: plan.previous?.id ?? null,
        cutoffSeq: plan.cutoffSeq,
        summary,
        model: cfg.model,
        runId: claim.runId,
        tokensBefore: plan.tokensBefore,
        tokensAfter,
        costMicro: totalCost,
      });
      await tx
        .update(runSteps)
        .set({ status: 'completed', finishedAt: new Date(), checkpoint: { version, cutoffSeq: plan.cutoffSeq } })
        .where(eq(runSteps.id, stepId));
      await appendEvent(tx, claim.runId, 'compaction_completed', { version, cutoffSeq: plan.cutoffSeq, tokensBefore: plan.tokensBefore, tokensAfter, costMicro: totalCost });
      await audit(tx, {
        actorUserId: claim.userId,
        action: 'context.compacted',
        entityType: 'conversation',
        entityId: claim.conversationId,
        runId: claim.runId,
        traceId: claim.traceId,
        payload: { version, cutoffSeq: plan.cutoffSeq, tokensBefore: plan.tokensBefore, tokensAfter, costMicro: totalCost, forced: force },
      });
    });
    log.info({ cutoffSeq: plan.cutoffSeq, tokensBefore: plan.tokensBefore, tokensAfter }, 'contexto compactado');
    return true;
  } catch (err) {
    if (err instanceof LeaseLostError || err instanceof CancelRequestedError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof InsufficientCreditsError ? 'insufficient_credits' : err instanceof LlmError ? err.code : 'compaction_error';
    await withTx(async ({ db: tx }) => {
      await fence(tx, claim);
      await tx.update(runSteps).set({ status: 'failed', finishedAt: new Date(), error: { code, message: message.slice(0, 500) } }).where(eq(runSteps.id, stepId));
      await appendEvent(tx, claim.runId, 'compaction_failed', { error: { code, message: message.slice(0, 500) } });
    });
    log.warn({ err }, 'compactação falhou; contexto anterior mantido');
    return false;
  }
}

function formatToolOutput(result: ToolResult, labels: (string | null)[]) {
  const parts = result.items.map((item, i) => {
    const label = labels[i];
    if (!item.source || !label) return item.content;
    const head = [`[${label}]`, item.source.title, item.source.url ? `<${item.source.url}>` : null].filter(Boolean).join(' ');
    return `${head}\n${item.content}`;
  });
  const body = parts.join('\n\n') || '(sem conteúdo)';
  return result.isError ? `A ferramenta retornou erro:\n${body}` : body;
}

const previewArgs = (args: string) => (args.length > 500 ? `${args.slice(0, 500)}…` : args);

/**
 * Executa as chamadas pedidas por uma etapa LLM. Chamadas de uma mesma resposta são independentes
 * e rodam em paralelo com limite. Cada resultado é persistido antes de o loop continuar.
 */
async function runTools(
  claim: Claim,
  calls: FunctionCall[],
  steps: StepRow[],
  byName: Map<string, RegisteredFn>,
  abort: AbortController,
  limits: { maxToolCalls: number; toolConcurrency: number },
) {
  const queue = [...calls];
  const errors: unknown[] = [];
  const worker = async () => {
    for (let call = queue.shift(); call; call = queue.shift()) {
      try {
        await runOneTool(claim, call, steps, byName, abort, limits.maxToolCalls);
      } catch (err) {
        errors.push(err);
        abort.abort();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limits.toolConcurrency, calls.length) }, worker));
  const fatal = errors.find((e) => e instanceof LeaseLostError) ?? errors.find((e) => e instanceof CancelRequestedError) ?? errors[0];
  if (fatal) throw fatal;
}

async function runOneTool(
  claim: Claim,
  call: FunctionCall,
  steps: StepRow[],
  byName: Map<string, RegisteredFn>,
  abort: AbortController,
  maxToolCalls: number,
) {
  const reg = byName.get(call.name);
  const toolKey = reg?.provider.key ?? 'unknown';

  // Abre (ou retoma) a etapa da tool.
  const opened = await withTx(async ({ db: tx }) => {
    const f = await fence(tx, claim);
    if (f.cancelRequested) throw new CancelRequestedError();
    const [existing] = await tx.select().from(toolCalls).where(and(eq(toolCalls.runId, claim.runId), eq(toolCalls.providerCallId, call.callId)));
    if (existing) return { stepId: existing.stepId, resumed: true };
    const [{ maxSeq, toolCount }] = (await tx
      .select({ maxSeq: sql<number>`coalesce(max(${runSteps.seq}), 0)::int`, toolCount: sql<number>`count(*) filter (where ${runSteps.kind} = 'tool_call')::int` })
      .from(runSteps)
      .where(eq(runSteps.runId, claim.runId))) as [{ maxSeq: number; toolCount: number }];
    const [step] = await tx.insert(runSteps).values({ runId: claim.runId, seq: maxSeq + 1, kind: 'tool_call', status: 'running' }).returning();
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.arguments || '{}');
    } catch {}
    await tx.insert(toolCalls).values({
      stepId: step!.id,
      runId: claim.runId,
      toolKey,
      toolVersion: reg?.provider.version ?? null,
      name: call.name,
      providerCallId: call.callId,
      arguments: args,
      status: 'running',
      sideEffect: reg?.fn.sideEffect ?? false,
    });
    await appendEvent(tx, claim.runId, 'tool_call_started', { callId: call.callId, name: call.name, toolKey, arguments: previewArgs(call.arguments) });
    return { stepId: step!.id, resumed: false, overLimit: toolCount + 1 > maxToolCalls };
  });

  const started = Date.now();
  let status: ToolCheckpoint['status'] = 'completed';
  let output: string;
  let error: ErrorDto | null = null;
  let result: ToolResult | null = null;

  if (opened.resumed && reg?.fn.sideEffect) {
    // Ação externa interrompida: pode ter ocorrido; nunca repetir automaticamente.
    status = 'unknown';
    error = { code: 'interrupted_side_effect', message: 'execução anterior interrompida; a ação não foi repetida' };
    output = 'Resultado desconhecido: a execução foi interrompida e, por ter efeito externo, não foi repetida automaticamente. Informe o usuário.';
  } else if ('overLimit' in opened && opened.overLimit) {
    status = 'blocked';
    error = { code: 'tool_limit', message: `limite de ${maxToolCalls} chamadas de ferramentas por resposta` };
    output = `Não executado: ${error.message}.`;
  } else if (!reg) {
    status = 'failed';
    error = { code: 'unknown_tool', message: `ferramenta ${call.name} não está disponível neste run` };
    output = `Erro: ${error.message}.`;
  } else {
    try {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.arguments || '{}');
        if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error();
      } catch {
        throw new ToolError('invalid_arguments', 'argumentos não são um objeto JSON válido');
      }
      const auth = await reg.provider.stillAuthorized();
      if (!auth.ok) {
        status = 'blocked';
        throw new ToolError(auth.code, auth.message);
      }
      const decision = await evaluateEgress(db(), reg.fn, args, claim.conversationId);
      if (!decision.allowed) {
        status = 'blocked';
        await withTx(async ({ db: tx }) => {
          await fence(tx, claim);
          await appendEvent(tx, claim.runId, 'policy_blocked', { callId: call.callId, name: call.name, code: decision.code, message: decision.message });
          await audit(tx, {
            actorUserId: claim.userId,
            action: 'policy.blocked',
            entityType: 'tool_call',
            entityId: call.callId,
            runId: claim.runId,
            traceId: claim.traceId,
            payload: { name: call.name, code: decision.code, arguments: previewArgs(call.arguments) },
          });
        });
        throw new ToolError(decision.code, decision.message);
      }
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(reg.fn.timeoutMs)]);
      result = await reg.fn.execute(args, { userId: claim.userId, conversationId: claim.conversationId, runId: claim.runId, signal });
      if (result.isError) status = 'failed';
      output = '';
    } catch (err) {
      if (err instanceof LeaseLostError || err instanceof CancelRequestedError) throw err;
      if (status === 'completed') status = 'failed';
      const code = err instanceof ToolError ? err.code : (err as { name?: string }).name === 'TimeoutError' ? 'timeout' : 'tool_error';
      const message = err instanceof Error ? err.message : String(err);
      error = { code, message: message.slice(0, 500) };
      output = status === 'blocked' ? `Bloqueado: ${message}` : `Erro na ferramenta ${call.name}: ${message}`;
    }
  }

  const durationMs = Date.now() - started;
  await withTx(async ({ db: tx }) => {
    await fence(tx, claim);
    let labels: (string | null)[] = [];
    if (result) {
      const withSource = result.items.map((i) => i.source ?? null);
      const registered = await registerSources(tx, claim.runId, claim.userId, withSource.filter((s): s is NonNullable<typeof s> => !!s));
      let k = 0;
      labels = withSource.map((s) => (s ? registered[k++]! : null));
      output = formatToolOutput(result, labels);
    }
    const checkpoint: ToolCheckpoint = { callId: call.callId, output, status };
    await tx
      .update(runSteps)
      .set({ status: status === 'completed' ? 'completed' : 'failed', checkpoint: checkpoint as unknown as Record<string, unknown>, error, finishedAt: new Date() })
      .where(eq(runSteps.id, opened.stepId));
    await tx
      .update(toolCalls)
      .set({ status, error, resultPreview: output.slice(0, 1000), durationMs, finishedAt: new Date() })
      .where(eq(toolCalls.stepId, opened.stepId));
    await appendEvent(tx, claim.runId, 'tool_call_completed', {
      callId: call.callId,
      name: call.name,
      status,
      durationMs,
      sourceLabels: labels.filter((l): l is string => !!l),
      error,
    });
    await audit(tx, {
      actorUserId: claim.userId,
      action: 'tool.call',
      entityType: 'tool_call',
      entityId: call.callId,
      runId: claim.runId,
      traceId: claim.traceId,
      payload: { name: call.name, toolKey, status, durationMs, error, sideEffect: reg?.fn.sideEffect ?? false },
    });
  });
}

/** Runs 'running' com lease vencido: worker caiu. Devolve IDs para reenfileirar. */
export async function findStaleRuns(d: Db): Promise<string[]> {
  const rows = await d
    .select({ id: runs.id })
    .from(runs)
    .where(and(inArray(runs.status, ['running']), sql`${runs.leaseExpiresAt} < now()`))
    .orderBy(asc(runs.leaseExpiresAt))
    .limit(50);
  return rows.map((r) => r.id);
}
