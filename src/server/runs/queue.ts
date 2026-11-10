import { PgBoss } from 'pg-boss';
import type pg from 'pg';

export const RUN_QUEUE = 'run-execute';
export type RunJob = { runId: string };

const g = globalThis as unknown as { __tessBoss?: Promise<PgBoss> };

/**
 * Instância pg-boss do processo. Na web serve só para enfileirar (sem supervisão/cron);
 * o worker cria a sua com supervisão ligada.
 */
export function getBoss(opts: { role: 'web' | 'worker' } = { role: 'web' }): Promise<PgBoss> {
  g.__tessBoss ??= (async () => {
    const boss = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      max: 3,
      supervise: opts.role === 'worker',
      schedule: false,
    });
    boss.on('error', (err) => console.error('[pg-boss]', err));
    await boss.start();
    await boss.createQueue(RUN_QUEUE, {
      // Execução real é limitada pelo engine; expiração é rede de segurança.
      expireInSeconds: 15 * 60,
      retryLimit: 5,
      retryDelay: 2,
      retryBackoff: true,
    }).catch((err: unknown) => {
      if (!String(err).includes('already exists')) throw err;
    });
    return boss;
  })();
  return g.__tessBoss;
}

export async function stopBoss() {
  const b = g.__tessBoss;
  g.__tessBoss = undefined;
  if (b) await (await b).stop({ graceful: true });
}

/** Enfileira o job na mesma transação do client informado: commit/rollback em conjunto com o run. */
export async function enqueueRunInTx(client: pg.PoolClient, runId: string) {
  const boss = await getBoss();
  return boss.send(RUN_QUEUE, { runId } satisfies RunJob, {
    db: { executeSql: (text: string, values?: unknown[]) => client.query(text, values as unknown[]) },
  });
}

/** Reenfileira fora de transação (recuperação). singletonKey evita duplicar jobs pendentes. */
export async function enqueueRun(runId: string) {
  const boss = await getBoss();
  return boss.send(RUN_QUEUE, { runId } satisfies RunJob, { singletonKey: runId });
}
