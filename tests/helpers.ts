import { sql } from 'drizzle-orm';
import { users } from '@/db/schema';
import { db } from '@/db/client';
import { runMigrations } from '@/db/migrator';
import { createUserAccount } from '@/server/credits/credits';

let migrated = false;

/** Migra uma vez e zera as tabelas da aplicação (o schema do pg-boss é mantido). */
export async function resetDb() {
  if (!migrated) {
    await runMigrations();
    migrated = true;
  }
  await db().execute(sql`
    truncate table shares, context_summaries, message_sources, sources, tool_calls, conversation_tools, tool_versions, tools, mcp_servers,
      connections, attachments, usage_ledger, credit_reservations, step_attempts, run_steps, run_events, runs,
      messages, conversations, sessions, audit_events, credit_accounts, users restart identity cascade`);
  // truncate não dispara triggers de UPDATE/DELETE; conta global recriada a seguir.
  await runMigrations();
}

export async function createTestUser(limitMicro = 1_000_000) {
  const [u] = await db().insert(users).values({ kind: 'demo', name: 'teste' }).returning();
  await createUserAccount(db(), u!.id, limitMicro);
  return u!;
}
