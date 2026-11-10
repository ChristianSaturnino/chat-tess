import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const micro = (name: string) => bigint(name, { mode: 'number' }).notNull().default(0);

export const users = pgTable(
  'users',
  {
    id: id(),
    kind: text('kind', { enum: ['google', 'demo'] }).notNull(),
    role: text('role', { enum: ['user', 'admin'] }).notNull().default('user'),
    googleSub: text('google_sub'),
    email: text('email'),
    name: text('name'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('users_google_sub_uq').on(t.googleSub)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('sessions_token_hash_uq').on(t.tokenHash), index('sessions_user_idx').on(t.userId)],
);

export const conversations = pgTable(
  'conversations',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    title: text('title'),
    nextSeq: integer('next_seq').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('conversations_user_idx').on(t.userId, t.updatedAt)],
);

export const MESSAGE_STATUS = ['pending', 'streaming', 'completed', 'failed', 'cancelled'] as const;

export const messages = pgTable(
  'messages',
  {
    id: id(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    status: text('status', { enum: MESSAGE_STATUS }).notNull(),
    /** Texto atual. Para o assistant em streaming, reflete o último lote persistido. */
    contentText: text('content_text').notNull().default(''),
    /** Blocos estruturados (anexos, referências). */
    blocks: jsonb('blocks').$type<unknown[]>().notNull().default([]),
    runId: uuid('run_id'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('messages_conversation_seq_uq').on(t.conversationId, t.seq)],
);

export const RUN_STATUS = [
  'queued',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
] as const;
export type RunStatus = (typeof RUN_STATUS)[number];
export const ACTIVE_RUN_STATUS: RunStatus[] = ['queued', 'running', 'waiting_approval'];

export type RunConfigSnapshot = {
  provider: string;
  model: string;
  maxOutputTokens: number;
  maxLlmAttempts: number;
  pricingVersion: string;
  systemPromptVersion: string;
};

export const runs = pgTable(
  'runs',
  {
    id: id(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    userMessageId: uuid('user_message_id').notNull(),
    assistantMessageId: uuid('assistant_message_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    status: text('status', { enum: RUN_STATUS }).notNull(),
    traceId: text('trace_id').notNull(),
    configSnapshot: jsonb('config_snapshot').$type<RunConfigSnapshot>().notNull(),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    /** Fencing token: incrementado a cada reivindicação; escritas exigem a versão atual. */
    version: integer('version').notNull().default(0),
    /** Contador de eventos; run_events.seq vem daqui. */
    eventSeq: integer('event_seq').notNull().default(0),
    error: jsonb('error').$type<{ code: string; message: string } | null>(),
    createdAt: createdAt(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('runs_user_idempotency_uq').on(t.userId, t.idempotencyKey),
    // Invariante: no máximo um run ativo por conversa.
    uniqueIndex('runs_one_active_per_conversation_uq')
      .on(t.conversationId)
      .where(sql`status in ('queued', 'running', 'waiting_approval')`),
    index('runs_status_lease_idx').on(t.status, t.leaseExpiresAt),
  ],
);

export const STEP_STATUS = ['running', 'completed', 'failed'] as const;

export const runSteps = pgTable(
  'run_steps',
  {
    id: id(),
    runId: uuid('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    kind: text('kind', { enum: ['llm_call', 'tool_call', 'compaction'] }).notNull(),
    status: text('status', { enum: STEP_STATUS }).notNull(),
    /** Saída confirmada da etapa; reutilizada após restart. */
    checkpoint: jsonb('checkpoint').$type<Record<string, unknown> | null>(),
    error: jsonb('error').$type<{ code: string; message: string } | null>(),
    startedAt: createdAt(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('run_steps_run_seq_uq').on(t.runId, t.seq)],
);

export const ATTEMPT_STATUS = ['running', 'completed', 'failed', 'unknown', 'cancelled'] as const;

export type UsageSnapshot = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
};

export const stepAttempts = pgTable(
  'step_attempts',
  {
    id: id(),
    stepId: uuid('step_id').notNull().references(() => runSteps.id, { onDelete: 'cascade' }),
    attemptNo: integer('attempt_no').notNull(),
    status: text('status', { enum: ATTEMPT_STATUS }).notNull(),
    runVersion: integer('run_version').notNull(),
    model: text('model'),
    providerRequestId: text('provider_request_id'),
    usage: jsonb('usage').$type<UsageSnapshot | null>(),
    error: jsonb('error').$type<{ code: string; message: string } | null>(),
    startedAt: createdAt(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('step_attempts_step_no_uq').on(t.stepId, t.attemptNo)],
);

export const runEvents = pgTable(
  'run_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: uuid('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('run_events_run_seq_uq').on(t.runId, t.seq)],
);

export const creditAccounts = pgTable(
  'credit_accounts',
  {
    id: id(),
    scope: text('scope', { enum: ['user', 'global'] }).notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    limitMicro: micro('limit_micro'),
    settledMicro: micro('settled_micro'),
    reservedMicro: micro('reserved_micro'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('credit_accounts_user_uq').on(t.userId),
    uniqueIndex('credit_accounts_single_global_uq').on(t.scope).where(sql`scope = 'global'`),
    check('credit_accounts_scope_user_ck', sql`(scope = 'global') = (user_id is null)`),
    check('credit_accounts_non_negative_ck', sql`settled_micro >= 0 and reserved_micro >= 0`),
  ],
);

export const RESERVATION_STATUS = ['pending', 'settled', 'released', 'unknown'] as const;

export const creditReservations = pgTable(
  'credit_reservations',
  {
    id: id(),
    attemptId: uuid('attempt_id').notNull().references(() => stepAttempts.id),
    userAccountId: uuid('user_account_id').notNull().references(() => creditAccounts.id),
    globalAccountId: uuid('global_account_id').notNull().references(() => creditAccounts.id),
    amountMicro: micro('amount_micro'),
    settledMicro: bigint('settled_micro', { mode: 'number' }),
    status: text('status', { enum: RESERVATION_STATUS }).notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('credit_reservations_attempt_uq').on(t.attemptId)],
);

/** Append-only (trigger na migration). Um lançamento por tentativa. */
export const usageLedger = pgTable(
  'usage_ledger',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    attemptId: uuid('attempt_id').notNull().references(() => stepAttempts.id),
    reservationId: uuid('reservation_id').references(() => creditReservations.id),
    userId: uuid('user_id').notNull().references(() => users.id),
    model: text('model').notNull(),
    pricingVersion: text('pricing_version').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    cachedInputTokens: integer('cached_input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    reasoningTokens: integer('reasoning_tokens').notNull(),
    costMicro: micro('cost_micro'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('usage_ledger_attempt_uq').on(t.attemptId)],
);

/** Append-only (trigger na migration). */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorUserId: uuid('actor_user_id'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    runId: uuid('run_id'),
    traceId: text('trace_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('audit_events_actor_idx').on(t.actorUserId, t.createdAt)],
);
