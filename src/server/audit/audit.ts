import { auditEvents } from '@/db/schema';
import type { Db } from '@/db/client';

export type AuditInput = {
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  runId?: string | null;
  traceId?: string | null;
  payload?: Record<string, unknown>;
};

/** Registrar na mesma transação da mutação auditada. Payload já deve vir sanitizado. */
export async function audit(d: Db, e: AuditInput) {
  await d.insert(auditEvents).values({
    actorUserId: e.actorUserId,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId ?? null,
    runId: e.runId ?? null,
    traceId: e.traceId ?? null,
    payload: e.payload ?? {},
  });
}
