import type { UsageSnapshot } from '@/db/schema';

export type LlmInputMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type LlmRequest = {
  model: string;
  instructions: string;
  input: LlmInputMessage[];
  maxOutputTokens: number;
  signal: AbortSignal;
};

export type LlmStreamEvent =
  | { type: 'request_id'; id: string }
  | { type: 'text_delta'; text: string }
  | { type: 'completed'; usage: UsageSnapshot; status: 'completed' | 'incomplete'; incompleteReason?: string };

/**
 * Classificação de erro para cobrança:
 * - 'not_billed': há evidência de que o provider rejeitou antes de processar (ex.: 400/401/429).
 * - 'unknown': rede/timeout/5xx/abort após envio — pode ter havido consumo.
 */
export class LlmError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly billing: 'not_billed' | 'unknown',
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface LlmAdapter {
  readonly provider: string;
  stream(req: LlmRequest): AsyncIterable<LlmStreamEvent>;
}
