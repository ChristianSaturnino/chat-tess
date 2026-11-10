import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { contextSummaries, conversations, runEvents, runSteps, runs, stepAttempts, toolCalls, usageLedger } from '@/db/schema';
import { db, type Db } from '@/db/client';
import type { RunEventDto, RunEventType } from '@/shared/events';
import { notFound } from '../errors';

export type RunSummaryDto = {
  runId: string;
  status: string;
  durationMs: number | null;
  costMicro: number;
  inputTokens: number;
  outputTokens: number;
  llmCalls: number;
  toolCalls: number;
  compactions: number;
};

/** Agregados por run para o rodapé de cada resposta. */
export async function runSummaries(d: Db, runIds: string[]): Promise<Map<string, RunSummaryDto>> {
  const out = new Map<string, RunSummaryDto>();
  if (!runIds.length) return out;
  const base = await d
    .select({ id: runs.id, status: runs.status, startedAt: runs.startedAt, finishedAt: runs.finishedAt })
    .from(runs)
    .where(inArray(runs.id, runIds));
  const usage = await d
    .select({
      runId: runSteps.runId,
      cost: sql<string>`coalesce(sum(${usageLedger.costMicro}), 0)`,
      input: sql<string>`coalesce(sum(${usageLedger.inputTokens}), 0)`,
      output: sql<string>`coalesce(sum(${usageLedger.outputTokens}), 0)`,
    })
    .from(usageLedger)
    .innerJoin(stepAttempts, eq(stepAttempts.id, usageLedger.attemptId))
    .innerJoin(runSteps, eq(runSteps.id, stepAttempts.stepId))
    .where(inArray(runSteps.runId, runIds))
    .groupBy(runSteps.runId);
  const steps = await d
    .select({ runId: runSteps.runId, kind: runSteps.kind, n: sql<number>`count(*)::int` })
    .from(runSteps)
    .where(inArray(runSteps.runId, runIds))
    .groupBy(runSteps.runId, runSteps.kind);
  for (const r of base) {
    const u = usage.find((x) => x.runId === r.id);
    const count = (kind: string) => steps.find((s) => s.runId === r.id && s.kind === kind)?.n ?? 0;
    out.set(r.id, {
      runId: r.id,
      status: r.status,
      durationMs: r.startedAt && r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
      costMicro: Number(u?.cost ?? 0),
      inputTokens: Number(u?.input ?? 0),
      outputTokens: Number(u?.output ?? 0),
      llmCalls: count('llm_call'),
      toolCalls: count('tool_call'),
      compactions: count('compaction'),
    });
  }
  return out;
}

/** Execução inspecionável de um run: ações observáveis, não o raciocínio interno do modelo. */
export async function getRunTimeline(userId: string, runId: string) {
  const [run] = await db()
    .select({ id: runs.id, conversationId: runs.conversationId, traceId: runs.traceId, config: runs.configSnapshot, error: runs.error })
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.userId, userId)));
  if (!run) throw notFound('execução');
  const events = await db()
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), ne(runEvents.type, 'text_delta')))
    .orderBy(asc(runEvents.seq));
  const calls = await db()
    .select({
      callId: toolCalls.providerCallId,
      name: toolCalls.name,
      toolKey: toolCalls.toolKey,
      status: toolCalls.status,
      arguments: toolCalls.arguments,
      resultPreview: toolCalls.resultPreview,
      error: toolCalls.error,
      durationMs: toolCalls.durationMs,
      sideEffect: toolCalls.sideEffect,
    })
    .from(toolCalls)
    .where(eq(toolCalls.runId, runId))
    .orderBy(asc(toolCalls.createdAt));
  const summary = (await runSummaries(db(), [runId])).get(runId)!;
  return {
    run: {
      id: run.id,
      traceId: run.traceId,
      model: run.config.model,
      tools: (run.config.tools ?? []).map((t) => t.key),
      error: run.error,
      ...summary,
    },
    events: events.map(
      (e): RunEventDto => ({ runId: e.runId, seq: e.seq, type: e.type as RunEventType, payload: e.payload as never, createdAt: e.createdAt.toISOString() }),
    ),
    toolCalls: calls,
  };
}

/** Versões da memória resumida da conversa, da mais recente para a mais antiga. */
export async function getConversationMemory(userId: string, conversationId: string) {
  const [conv] = await db()
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)));
  if (!conv) throw notFound('conversa');
  const rows = await db()
    .select()
    .from(contextSummaries)
    .where(eq(contextSummaries.conversationId, conversationId))
    .orderBy(sql`${contextSummaries.version} desc`);
  return rows.map((r) => ({
    version: r.version,
    cutoffSeq: r.cutoffSeq,
    summary: r.summary,
    model: r.model,
    tokensBefore: r.tokensBefore,
    tokensAfter: r.tokensAfter,
    costMicro: r.costMicro,
    runId: r.runId,
    createdAt: r.createdAt.toISOString(),
    active: r.version === rows[0]!.version,
  }));
}
