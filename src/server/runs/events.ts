import { and, asc, eq, gt } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { runEvents } from '@/db/schema';
import type { Db } from '@/db/client';
import type { RunEventDto, RunEventPayloads, RunEventType } from '@/shared/events';

/**
 * Acrescenta evento com seq monotônico por run (contador em runs.event_seq).
 * O UPDATE serializa escritores concorrentes do mesmo run dentro da transação.
 */
export async function appendEvent<T extends RunEventType>(tx: Db, runId: string, type: T, payload: RunEventPayloads[T]) {
  const r = await tx.execute<{ event_seq: number }>(
    sql`update runs set event_seq = event_seq + 1 where id = ${runId} returning event_seq`,
  );
  const seq = r.rows[0]?.event_seq;
  if (seq === undefined) throw new Error(`run ${runId} inexistente`);
  await tx.insert(runEvents).values({ runId, seq, type, payload: payload as Record<string, unknown> });
  return seq;
}

export async function readEventsAfter(d: Db, runId: string, afterSeq: number, limit = 200): Promise<RunEventDto[]> {
  const rows = await d
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
    .orderBy(asc(runEvents.seq))
    .limit(limit);
  return rows.map((r) => ({
    runId: r.runId,
    seq: r.seq,
    type: r.type as RunEventType,
    payload: r.payload as never,
    createdAt: r.createdAt.toISOString(),
  }));
}
