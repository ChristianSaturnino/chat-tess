import { sql } from 'drizzle-orm';
import { closeDb, db } from '../src/db/client';
import { runMigrations } from '../src/db/migrator';

/** Banco de teste migrado e limpo antes da suíte E2E. */
export default async function globalSetup() {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://tess:tess@localhost:5433/tess_test';
  await runMigrations();
  await db().execute(sql`
    truncate table shares, context_summaries, message_sources, sources, tool_calls, conversation_tools, tool_versions, tools,
      mcp_servers, connections, attachments, usage_ledger, credit_reservations, step_attempts, run_steps, run_events, runs,
      messages, conversations, sessions, audit_events, credit_accounts, users restart identity cascade`);
  await runMigrations();
  await closeDb();
}
