import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;

type Handle = { pool: pg.Pool; db: Db };
const globalForDb = globalThis as unknown as { __tessDb?: Handle };

function create(): Handle {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL não configurada');
  const pool = new pg.Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX ?? 10) });
  return { pool, db: drizzle(pool, { schema }) };
}

/** Pool único por processo (sobrevive ao hot reload do Next em dev). */
export function getDbHandle(): Handle {
  globalForDb.__tessDb ??= create();
  return globalForDb.__tessDb;
}

export const db = (): Db => getDbHandle().db;

export type Tx = { db: Db; client: pg.PoolClient };

/**
 * Transação em um cliente dedicado. Expõe o client cru para que o pg-boss
 * enfileire jobs na mesma transação (executeSql no mesmo client).
 */
export async function withTx<T>(fn: (tx: Tx) => Promise<T>, opts?: { isolation?: 'repeatable read' | 'serializable' }): Promise<T> {
  const client = await getDbHandle().pool.connect();
  try {
    await client.query(opts?.isolation ? `BEGIN ISOLATION LEVEL ${opts.isolation.toUpperCase()}` : 'BEGIN');
    const result = await fn({ db: drizzle(client, { schema }), client });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closeDb() {
  const h = globalForDb.__tessDb;
  globalForDb.__tessDb = undefined;
  await h?.pool.end();
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const inner = e?.code ? e : e?.cause;
  return inner?.code === '23505' && (!constraint || inner.constraint === constraint);
}
