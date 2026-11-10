import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { attachments, messageSources, messages, PRIVATE_SOURCE_KINDS, runs, sources } from '@/db/schema';
import type { Db } from '@/db/client';
import type { SourceInput } from '../tools/types';

/**
 * Registra fontes obtidas no run e devolve rótulos citáveis (S1, S2…). A mesma fonte no mesmo run
 * mantém o rótulo. Chamar com a linha do run bloqueada (fence), o que serializa a numeração.
 */
export async function registerSources(tx: Db, runId: string, userId: string, inputs: SourceInput[]): Promise<string[]> {
  const labels: string[] = [];
  for (const s of inputs) {
    const [existing] = await tx
      .select({ label: sources.label })
      .from(sources)
      .where(and(eq(sources.runId, runId), eq(sources.kind, s.kind), eq(sources.ref, s.ref)));
    if (existing) {
      labels.push(existing.label);
      continue;
    }
    const [{ n }] = (await tx.select({ n: sql<number>`count(*)::int` }).from(sources).where(eq(sources.runId, runId))) as [{ n: number }];
    const label = `S${n + 1}`;
    await tx.insert(sources).values({
      runId,
      userId,
      label,
      kind: s.kind,
      ref: s.ref,
      title: s.title,
      url: s.url,
      excerpt: s.excerpt ?? null,
      contentHash: s.contentHash ?? null,
    });
    labels.push(label);
  }
  return labels;
}

/**
 * Liga as fontes do run à resposta. Só rótulos que existem no run contam como citados;
 * rótulos inventados pelo modelo são ignorados. Fontes consultadas e não citadas ficam como cited=false.
 */
export async function linkMessageSources(tx: Db, runId: string, messageId: string, text: string, extraCitedRefs: string[] = []) {
  const runSources = await tx.select().from(sources).where(eq(sources.runId, runId)).orderBy(asc(sources.retrievedAt));
  if (!runSources.length) return { cited: 0, consulted: 0 };
  const citedLabels = new Set([...text.matchAll(/\[(S\d+)\]/g)].map((m) => m[1]!));
  const extra = new Set(extraCitedRefs);
  const rows = runSources.map((s) => ({ messageId, sourceId: s.id, cited: citedLabels.has(s.label) || (s.kind === 'web' && extra.has(s.ref)) }));
  await tx.insert(messageSources).values(rows).onConflictDoNothing();
  return { cited: rows.filter((r) => r.cited).length, consulted: rows.length };
}

/** Conversa já recebeu dado privado (fonte privada consultada ou anexo enviado)? */
export async function conversationHasPrivateData(d: Db, conversationId: string): Promise<boolean> {
  const [src] = await d
    .select({ id: sources.id })
    .from(sources)
    .innerJoin(runs, eq(runs.id, sources.runId))
    .where(and(eq(runs.conversationId, conversationId), inArray(sources.kind, PRIVATE_SOURCE_KINDS)))
    .limit(1);
  if (src) return true;
  const [att] = await d
    .select({ id: attachments.id })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .where(eq(messages.conversationId, conversationId))
    .limit(1);
  return !!att;
}

/** URLs já obtidas como fonte web nesta conversa: destinos considerados revisados pela política. */
export async function knownWebUrls(d: Db, conversationId: string): Promise<Set<string>> {
  const rows = await d
    .select({ url: sources.url })
    .from(sources)
    .innerJoin(runs, eq(runs.id, sources.runId))
    .where(and(eq(runs.conversationId, conversationId), eq(sources.kind, 'web')));
  return new Set(rows.map((r) => r.url).filter((u): u is string => !!u).map(normalizeUrl));
}

export function normalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = '';
    return url.toString();
  } catch {
    return u;
  }
}

export async function messageSourcesFor(d: Db, messageIds: string[]) {
  if (!messageIds.length) return [];
  return d
    .select({
      messageId: messageSources.messageId,
      cited: messageSources.cited,
      label: sources.label,
      kind: sources.kind,
      title: sources.title,
      url: sources.url,
      excerpt: sources.excerpt,
    })
    .from(messageSources)
    .innerJoin(sources, eq(sources.id, messageSources.sourceId))
    .where(inArray(messageSources.messageId, messageIds))
    .orderBy(asc(sources.label));
}
