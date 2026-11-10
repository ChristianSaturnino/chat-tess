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
  /** Tools habilitadas congeladas no início do run; revogação ainda é revalidada a cada chamada. */
  tools?: ToolSnapshot[];
  webSearch?: { maxCalls: number; feeMicroPerCall: number; tokensPerCall?: number } | null;
  limits?: { maxIterations: number; maxToolCalls: number };
};

export type ToolSnapshot = { key: string; version: string };

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
    webSearchCalls: integer('web_search_calls').notNull().default(0),
    /** Tarifas de tools nativas do provider, separadas do custo de tokens. */
    toolFeeMicro: micro('tool_fee_micro'),
    /** Total cobrado: tokens + tarifas. */
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

export const ATTACHMENT_STATUS = ['ready', 'attached', 'deleted'] as const;

export const attachments = pgTable(
  'attachments',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    storageKey: text('storage_key').notNull(),
    filename: text('filename').notNull(),
    /** Tipo detectado pelos bytes, não pelo que o navegador declarou. */
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    status: text('status', { enum: ATTACHMENT_STATUS }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('attachments_user_idx').on(t.userId), index('attachments_message_idx').on(t.messageId)],
);

export const CONNECTION_STATUS = ['active', 'reconnect_required', 'revoked'] as const;

/** Autorização de um serviço externo por usuário. Separada da identidade de login. */
export const connections = pgTable(
  'connections',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: ['google'] }).notNull(),
    service: text('service', { enum: ['drive', 'gmail'] }).notNull(),
    externalAccountId: text('external_account_id').notNull(),
    externalEmail: text('external_email'),
    grantedScopes: text('granted_scopes').array().notNull(),
    accessTokenEnc: text('access_token_enc'),
    refreshTokenEnc: text('refresh_token_enc'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    status: text('status', { enum: CONNECTION_STATUS }).notNull(),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('connections_user_service_uq').on(t.userId, t.provider, t.service)],
);

export type HttpToolConfig = {
  method: 'GET' | 'POST';
  url: string;
  /** JSON Schema dos argumentos que o modelo envia. */
  parameters: Record<string, unknown>;
  /** Cabeçalhos cifrados (ex.: Authorization). Nunca entram no prompt. */
  secretHeadersEnc: string | null;
  sideEffect: boolean;
};

/** Tool HTTP cadastrada pelo usuário. Configuração versionada e imutável por versão. */
export const tools = pgTable(
  'tools',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull(),
    currentVersion: integer('current_version').notNull().default(1),
    status: text('status', { enum: ['active', 'deleted'] }).notNull().default('active'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('tools_user_name_uq').on(t.userId, t.name).where(sql`status = 'active'`)],
);

export const toolVersions = pgTable(
  'tool_versions',
  {
    id: id(),
    toolId: uuid('tool_id').notNull().references(() => tools.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    config: jsonb('config').$type<HttpToolConfig>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('tool_versions_tool_version_uq').on(t.toolId, t.version)],
);

export type McpToolDef = { name: string; description: string; inputSchema: Record<string, unknown>; readOnlyHint?: boolean };

export const mcpServers = pgTable('mcp_servers', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  url: text('url').notNull(),
  bearerTokenEnc: text('bearer_token_enc'),
  catalog: jsonb('catalog').$type<McpToolDef[]>().notNull().default([]),
  catalogVersion: integer('catalog_version').notNull().default(0),
  catalogHash: text('catalog_hash'),
  status: text('status', { enum: ['active', 'error', 'deleted'] }).notNull().default('active'),
  lastError: text('last_error'),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  createdAt: createdAt(),
});

/**
 * Habilitação de tools por conversa. tool_key: builtin:<nome> | http:<toolId> | mcp:<serverId> | google:<service>.
 * Ausência de linha = padrão da tool (ver ToolRegistry).
 */
export const conversationTools = pgTable(
  'conversation_tools',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    toolKey: text('tool_key').notNull(),
    enabled: boolean('enabled').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('conversation_tools_pk').on(t.conversationId, t.toolKey)],
);

export const TOOL_CALL_STATUS = ['running', 'completed', 'failed', 'blocked', 'unknown'] as const;

export const toolCalls = pgTable(
  'tool_calls',
  {
    id: id(),
    stepId: uuid('step_id').notNull().references(() => runSteps.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
    toolKey: text('tool_key').notNull(),
    toolVersion: text('tool_version'),
    name: text('name').notNull(),
    providerCallId: text('provider_call_id').notNull(),
    /** Argumentos validados; secrets nunca aparecem aqui. */
    arguments: jsonb('arguments').$type<Record<string, unknown>>().notNull(),
    resultPreview: text('result_preview'),
    status: text('status', { enum: TOOL_CALL_STATUS }).notNull(),
    error: jsonb('error').$type<{ code: string; message: string } | null>(),
    sideEffect: boolean('side_effect').notNull().default(false),
    durationMs: integer('duration_ms'),
    createdAt: createdAt(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('tool_calls_step_uq').on(t.stepId), uniqueIndex('tool_calls_run_call_uq').on(t.runId, t.providerCallId)],
);

export const SOURCE_KINDS = ['web', 'attachment', 'drive', 'gmail', 'mcp', 'http'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
/** Fontes cujo conteúdo é privado do usuário: ativam a política contra exfiltração. */
export const PRIVATE_SOURCE_KINDS: SourceKind[] = ['attachment', 'drive', 'gmail'];

/** Material efetivamente obtido durante um run. Referência não concede acesso ao original. */
export const sources = pgTable(
  'sources',
  {
    id: id(),
    runId: uuid('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    /** Rótulo citável dentro do run (S1, S2…). */
    label: text('label').notNull(),
    kind: text('kind', { enum: SOURCE_KINDS }).notNull(),
    ref: text('ref').notNull(),
    title: text('title'),
    url: text('url'),
    contentHash: text('content_hash'),
    excerpt: text('excerpt'),
    retrievedAt: createdAt(),
  },
  (t) => [uniqueIndex('sources_run_label_uq').on(t.runId, t.label), uniqueIndex('sources_run_kind_ref_uq').on(t.runId, t.kind, t.ref)],
);

export const messageSources = pgTable(
  'message_sources',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    cited: boolean('cited').notNull(),
  },
  (t) => [uniqueIndex('message_sources_pk').on(t.messageId, t.sourceId)],
);
