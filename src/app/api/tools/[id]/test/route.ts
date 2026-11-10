import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withTx } from '@/db/client';
import { audit } from '@/server/audit/audit';
import { assertSameOrigin, requireUser, route } from '@/server/http';
import { httpToolProvider, listHttpTools } from '@/server/tools/http-tools';
import { notFound } from '@/server/errors';

/** Execução de teste pelo dono, fora de um run, com os mesmos limites e validações. */
export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  const user = await requireUser();
  const id = z.uuid().parse((await ctx.params).id);
  const args = z.record(z.string(), z.unknown()).parse(await req.json());
  const meta = (await listHttpTools(user.id)).find((t) => t.id === id);
  if (!meta) throw notFound('tool');
  const provider = await httpToolProvider(user.id, id, meta.version);
  if (!provider) throw notFound('tool');
  const started = Date.now();
  let preview: string;
  let ok = true;
  try {
    const result = await provider.functions[0]!.execute(args, { userId: user.id, conversationId: '', runId: '', signal: AbortSignal.timeout(25_000) });
    preview = result.items.map((i) => i.content).join('\n\n').slice(0, 4000);
  } catch (err) {
    ok = false;
    preview = err instanceof Error ? err.message : String(err);
  }
  await withTx(({ db: tx }) => audit(tx, { actorUserId: user.id, action: 'tool.test', entityType: 'tool', entityId: id, payload: { ok, durationMs: Date.now() - started } }));
  return NextResponse.json({ ok, preview, durationMs: Date.now() - started });
});
