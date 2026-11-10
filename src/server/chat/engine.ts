import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { messages, runSteps, runs, stepAttempts, type RunConfigSnapshot, type UsageSnapshot } from '@/db/schema';
import { withTx, type Db } from '@/db/client';
import type { ErrorDto } from '@/shared/events';
import { audit } from '../audit/audit';
import { config, type Pricing } from '../config';
import { InsufficientCreditsError, markUnknown, release, reserve, settle } from '../credits/credits';
import { costMicro, reservationMicro } from '../credits/pricing';
import { getLlm } from '../llm';
import { LlmError } from '../llm/types';
import { logger } from '../logger';
import { appendEvent } from '../runs/events';
import { buildContext, SYSTEM_PROMPT } from './context';

class LeaseLostError extends Error {
  constructor() {
    super('lease perdido: outro worker assumiu o run');
  }
}

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

const LLM_STEP_SEQ = 1;

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

type Terminal = { status: 'completed' | 'failed' | 'cancelled' | 'interrupted'; error?: ErrorDto; costMicro?: number };

async function finalize(tx: Db, claim: Claim, t: Terminal) {
  const msgStatus = t.status === 'completed' ? 'completed' : t.status === 'cancelled' ? 'cancelled' : 'failed';
  await tx.update(messages).set({ status: msgStatus }).where(eq(messages.id, claim.assistantMessageId));
  await tx
    .update(runs)
    .set({ status: t.status, error: t.error ?? null, finishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null })
    .where(eq(runs.id, claim.runId));
  const messageId = claim.assistantMessageId;
  if (t.status === 'completed') await appendEvent(tx, claim.runId, 'run_completed', { messageId, costMicro: t.costMicro ?? 0 });
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
 * Tentativas encontradas em 'running' pertencem a um worker anterior que caiu.
 * Não sabemos se o provider processou: consumo 'unknown', reserva mantida.
 */
async function resolveOrphanAttempts(tx: Db, claim: Claim) {
  const orphans = await tx
    .select({ id: stepAttempts.id, stepId: stepAttempts.stepId })
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
    if (claimed.cancelRequested) {
      await withTx(async ({ db: tx }) => {
        await fence(tx, claim);
        await resolveOrphanAttempts(tx, claim);
        await finalize(tx, claim, { status: 'cancelled' });
      });
      return 'cancelled';
    }

    const prep = await withTx(async ({ db: tx }) => {
      await fence(tx, claim);
      await resolveOrphanAttempts(tx, claim);
      const [step] = await tx
        .select()
        .from(runSteps)
        .where(and(eq(runSteps.runId, claim.runId), eq(runSteps.seq, LLM_STEP_SEQ)));
      return step ?? null;
    });

    // Etapa já confirmada (queda entre checkpoint e finalização): reaproveita sem nova chamada.
    if (prep?.status === 'completed' && prep.checkpoint) {
      await withTx(async ({ db: tx }) => {
        await fence(tx, claim);
        await finalize(tx, claim, { status: 'completed', costMicro: Number(prep.checkpoint?.costMicro ?? 0) });
      });
      return 'completed';
    }

    return await runLlmStep(claim, abort, () => leaseLost, log);
  } catch (err) {
    if (err instanceof LeaseLostError || leaseLost) {
      log.warn('lease perdido; encerrando sem escrever');
      return 'skipped';
    }
    log.error({ err }, 'erro inesperado no run');
    // Falha inesperada: deixa o run em 'running' com lease expirando → recuperação pelo sweeper/retry.
    throw err;
  } finally {
    stopHeartbeat();
  }
}

async function runLlmStep(
  claim: Claim,
  abort: AbortController,
  isLeaseLost: () => boolean,
  log: typeof logger,
): Promise<ExecuteResult> {
  const cfg = claim.cfg;
  const limits = config().limits;
  const pricing: Pricing = { ...config().llm.pricing, version: cfg.pricingVersion };
  const llm = getLlm(cfg.provider);

  for (;;) {
    // Etapa, tentativa e reserva na mesma transação.
    let prepared: { id: string; stepId: string; attemptNo: number; reservedMicro: number; input: Awaited<ReturnType<typeof buildContext>> } | null;
    try {
      prepared = await withTx(async ({ db: tx }) => {
        await fence(tx, claim);
        const [userMsg] = await tx.select({ seq: messages.seq }).from(messages).where(eq(messages.id, claim.userMessageId));
        const input = await buildContext(tx, claim.conversationId, userMsg!.seq);

        let [step] = await tx
          .select()
          .from(runSteps)
          .where(and(eq(runSteps.runId, claim.runId), eq(runSteps.seq, LLM_STEP_SEQ)));
        step ??= (await tx.insert(runSteps).values({ runId: claim.runId, seq: LLM_STEP_SEQ, kind: 'llm_call', status: 'running' }).returning())[0]!;

        const prior = await tx.select({ n: sql<number>`count(*)::int` }).from(stepAttempts).where(eq(stepAttempts.stepId, step.id));
        const attemptNo = (prior[0]?.n ?? 0) + 1;
        if (attemptNo > cfg.maxLlmAttempts) return null;

        const [att] = await tx
          .insert(stepAttempts)
          .values({ stepId: step.id, attemptNo, status: 'running', runVersion: claim.version, model: cfg.model })
          .returning({ id: stepAttempts.id });

        const inputChars = SYSTEM_PROMPT.length + input.reduce((n, m) => n + m.content.length, 0);
        const reservedMicro = reservationMicro(inputChars, cfg.maxOutputTokens, pricing);
        await reserve(tx, { userId: claim.userId, attemptId: att!.id, amountMicro: reservedMicro });

        // Nova geração substitui explicitamente qualquer texto parcial anterior.
        await tx.update(messages).set({ status: 'streaming', contentText: '' }).where(eq(messages.id, claim.assistantMessageId));
        await appendEvent(tx, claim.runId, 'attempt_started', {
          attemptId: att!.id,
          stepId: step.id,
          attemptNo,
          model: cfg.model,
          reservedMicro,
          messageId: claim.assistantMessageId,
        });
        return { id: att!.id, stepId: step.id, attemptNo, reservedMicro, input };
      }).then(async (r) => {
        if (r) return r;
        await withTx(async ({ db: tx }) => {
          await fence(tx, claim);
          await finalize(tx, claim, {
            status: 'interrupted',
            error: { code: 'attempts_exhausted', message: 'limite de tentativas atingido após falhas/interrupções' },
          });
        });
        return null;
      });
      if (!prepared) return 'interrupted';
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
        await tx.update(messages).set({ contentText: text }).where(eq(messages.id, claim.assistantMessageId));
        await appendEvent(tx, claim.runId, 'text_delta', { attemptId: attempt.id, messageId: claim.assistantMessageId, text: chunk });
        if (f.cancelRequested && !cancelled) {
          cancelled = true;
          abort.abort();
        }
      });
    };

    // Cancelamento também é observado sem deltas (ex.: modelo pensando).
    const cancelPoll = setInterval(() => {
      withTx(async ({ db: tx }) => {
        const [r] = await tx.select({ c: runs.cancelRequested }).from(runs).where(eq(runs.id, claim.runId));
        if (r?.c && !cancelled) {
          cancelled = true;
          abort.abort();
        }
      }).catch(() => {});
    }, 1000);

    let outcome: { kind: 'ok'; usage: UsageSnapshot; incomplete?: string } | { kind: 'error'; error: LlmError };
    try {
      outcome = { kind: 'error', error: new LlmError('stream_ended', 'stream encerrado sem conclusão', 'unknown', true) };
      for await (const ev of llm.stream({
        model: cfg.model,
        instructions: SYSTEM_PROMPT,
        input: attempt.input,
        maxOutputTokens: cfg.maxOutputTokens,
        signal: abort.signal,
      })) {
        if (ev.type === 'request_id') requestId = ev.id;
        else if (ev.type === 'text_delta') {
          text += ev.text;
          pending += ev.text;
          if (pending.length >= limits.deltaFlushChars || Date.now() - lastFlush >= limits.deltaFlushMs) await flush();
        } else if (ev.type === 'completed') {
          outcome = { kind: 'ok', usage: ev.usage, incomplete: ev.status === 'incomplete' ? (ev.incompleteReason ?? 'incomplete') : undefined };
          break;
        }
      }
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

    if (outcome.kind === 'ok') {
      const usage = outcome.usage;
      const cost = costMicro(usage, pricing);
      const durationMs = Date.now() - started;
      const incomplete = outcome.incomplete;
      await withTx(async ({ db: tx }) => {
        await fence(tx, claim);
        if (pending) {
          await appendEvent(tx, claim.runId, 'text_delta', { attemptId: attempt.id, messageId: claim.assistantMessageId, text: pending });
          pending = '';
        }
        await tx.update(messages).set({ contentText: text }).where(eq(messages.id, claim.assistantMessageId));
        await settle(tx, { attemptId: attempt.id, userId: claim.userId, model: cfg.model, pricingVersion: pricing.version, usage, costMicro: cost });
        await tx
          .update(stepAttempts)
          .set({ status: 'completed', usage, providerRequestId: requestId ?? null, finishedAt: new Date() })
          .where(eq(stepAttempts.id, attempt.id));
        await tx
          .update(runSteps)
          .set({ status: 'completed', finishedAt: new Date(), checkpoint: { text, usage, costMicro: cost, incomplete: incomplete ?? null } })
          .where(eq(runSteps.id, attempt.stepId));
        await appendEvent(tx, claim.runId, 'attempt_completed', { attemptId: attempt.id, usage, costMicro: cost, durationMs });
        await audit(tx, {
          actorUserId: claim.userId,
          action: 'llm.call',
          entityType: 'step_attempt',
          entityId: attempt.id,
          runId: claim.runId,
          traceId: claim.traceId,
          payload: { model: cfg.model, usage, costMicro: cost, durationMs, incomplete: incomplete ?? null },
        });
        await finalize(tx, claim, { status: 'completed', costMicro: cost });
      });
      log.info({ costMicro: cost, durationMs }, 'run concluído');
      return 'completed';
    }

    const error = outcome.error;
    if (cancelled) {
      await withTx(async ({ db: tx }) => {
        await fence(tx, claim);
        if (pending) {
          await appendEvent(tx, claim.runId, 'text_delta', { attemptId: attempt.id, messageId: claim.assistantMessageId, text: pending });
        }
        await tx.update(messages).set({ contentText: text }).where(eq(messages.id, claim.assistantMessageId));
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

    const retrying = error.retryable && attempt.attemptNo < cfg.maxLlmAttempts;
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
    if (!retrying) return 'failed';
  }
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
