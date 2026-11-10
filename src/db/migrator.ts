import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db } from './client';
import { ensureGlobalAccount } from '../server/credits/credits';

export async function runMigrations() {
  await migrate(db(), { migrationsFolder: fileURLToPath(new URL('./migrations', import.meta.url)) });
  await ensureGlobalAccount();
}
