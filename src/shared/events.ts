/** Contrato de eventos persistidos em run_events e enviados ao cliente via SSE. */

export type BillingOutcome = 'settled' | 'released' | 'unknown';

export type RunEventPayloads = {
  run_queued: { userMessageId: string; assistantMessageId: string };
  run_started: { version: number; resumed: boolean };
  /** Nova tentativa de geração: o cliente deve descartar o texto parcial anterior da mensagem. */
  attempt_started: { attemptId: string; stepId: string; attemptNo: number; model: string; reservedMicro: number; messageId: string };
  text_delta: { attemptId: string; messageId: string; text: string };
  attempt_completed: { attemptId: string; usage: UsageDto; costMicro: number; durationMs: number };
  attempt_failed: { attemptId: string; error: ErrorDto; billing: BillingOutcome; retrying: boolean };
  /** Tentativa encontrada em andamento após queda do worker: resultado/consumo desconhecidos. */
  attempt_interrupted: { attemptId: string; billing: 'unknown' };
  cancel_requested: Record<string, never>;
  run_completed: { messageId: string; costMicro: number };
  run_failed: { messageId: string; error: ErrorDto };
  run_cancelled: { messageId: string };
  run_interrupted: { messageId: string; error: ErrorDto };
};

export type RunEventType = keyof RunEventPayloads;

export type UsageDto = { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number };
export type ErrorDto = { code: string; message: string };

export type RunEventDto<T extends RunEventType = RunEventType> = {
  runId: string;
  seq: number;
  type: T;
  payload: RunEventPayloads[T];
  createdAt: string;
};

export const TERMINAL_EVENTS: RunEventType[] = ['run_completed', 'run_failed', 'run_cancelled', 'run_interrupted'];

export type MessageDto = {
  id: string;
  seq: number;
  role: 'user' | 'assistant';
  status: 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled';
  contentText: string;
  runId: string | null;
  createdAt: string;
};

export type ConversationSnapshotDto = {
  conversation: { id: string; title: string | null };
  messages: MessageDto[];
  activeRun: { id: string; status: string; lastEventSeq: number } | null;
};
