import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { closeDb, db } from '@/db/client';
import { executeRun, findStaleRuns } from '@/server/chat/engine';
import { config } from '@/server/config';
import { logger } from '@/server/logger';
import { enqueueRun, getBoss, RUN_QUEUE, stopBoss, type RunJob } from '@/server/runs/queue';

const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const SWEEP_MS = 15_000;

async function main() {
  config(); // falha no boot se o ambiente estiver inválido
  const boss = await getBoss({ role: 'worker' });
  logger.info({ workerId }, 'worker iniciado');

  await boss.work<RunJob>(RUN_QUEUE, { localConcurrency: Number(process.env.WORKER_CONCURRENCY ?? 4) }, async (jobs) => {
    for (const job of jobs) {
      const result = await executeRun(job.data.runId, workerId);
      logger.info({ runId: job.data.runId, result }, 'job concluído');
    }
  });

  // Recuperação: runs com lease vencido (worker anterior caiu) voltam para a fila.
  const sweep = async () => {
    try {
      for (const runId of await findStaleRuns(db())) {
        logger.warn({ runId }, 'run com lease vencido; reenfileirando');
        await enqueueRun(runId);
      }
    } catch (err) {
      logger.error({ err }, 'sweep falhou');
    }
  };
  await sweep();
  const timer = setInterval(sweep, SWEEP_MS);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'encerrando worker');
    clearInterval(timer);
    await stopBoss();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'worker falhou ao iniciar');
  process.exit(1);
});
