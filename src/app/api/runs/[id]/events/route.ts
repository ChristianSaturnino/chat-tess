import { z } from 'zod';
import { db } from '@/db/client';
import { requireUser, route } from '@/server/http';
import { getOwnedRun } from '@/server/runs/commands';
import { readEventsAfter } from '@/server/runs/events';
import { TERMINAL_EVENTS } from '@/shared/events';

export const dynamic = 'force-dynamic';

const POLL_MS = 250;
const HEARTBEAT_MS = 15_000;
/** Abaixo do limite do proxy (Railway fecha após 15 min); o cliente reconecta com o cursor. */
const MAX_STREAM_MS = 10 * 60_000;

/**
 * SSE com cursor: envia eventos com seq > cursor (query ?after= ou Last-Event-ID).
 * A execução nunca depende desta conexão; ela apenas lê o que o worker persistiu.
 */
export const GET = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const runId = z.uuid().parse((await ctx.params).id);
  await getOwnedRun({ userId: user.id }, runId);

  const url = new URL(req.url);
  const fromHeader = req.headers.get('last-event-id');
  let cursor = z.coerce.number().int().nonnegative().catch(0).parse(fromHeader ?? url.searchParams.get('after') ?? 0);

  const encoder = new TextEncoder();
  const signal = req.signal;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => controller.enqueue(encoder.encode(s));
      const started = Date.now();
      let lastBeat = Date.now();
      send('retry: 2000\n\n');
      try {
        while (!signal.aborted && Date.now() - started < MAX_STREAM_MS) {
          const events = await readEventsAfter(db(), runId, cursor);
          let terminal = false;
          for (const ev of events) {
            send(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
            cursor = ev.seq;
            if (TERMINAL_EVENTS.includes(ev.type)) terminal = true;
          }
          if (terminal) {
            send('event: end\ndata: {}\n\n');
            break;
          }
          if (Date.now() - lastBeat > HEARTBEAT_MS) {
            send(': heartbeat\n\n');
            lastBeat = Date.now();
          }
          if (events.length === 0) await new Promise((r) => setTimeout(r, POLL_MS));
        }
      } catch {
        // conexão fechada ou erro de leitura: o cliente reconecta com Last-Event-ID
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});
