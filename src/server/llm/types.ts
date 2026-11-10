import type { UsageSnapshot } from '@/db/schema';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; dataBase64: string; filename: string }
  | { type: 'file'; mimeType: string; dataBase64: string; filename: string };

/**
 * Itens de contexto independentes de provider. 'opaque' preserva itens de protocolo
 * (reasoning cifrado, chamadas de busca nativa, mensagens com metadados) para reenvio fiel.
 */
export type LlmItem =
  | { kind: 'message'; role: 'user' | 'assistant'; content: ContentPart[] }
  | { kind: 'function_call'; callId: string; name: string; arguments: string }
  | { kind: 'function_call_output'; callId: string; output: string }
  | { kind: 'opaque'; provider: string; item: unknown };

export type LlmToolDef = { name: string; description: string; parameters: Record<string, unknown> };

export type LlmRequest = {
  model: string;
  instructions: string;
  input: LlmItem[];
  tools: LlmToolDef[];
  /** Busca nativa do provider; maxCalls é o teto usado na reserva de créditos. */
  webSearch: { maxCalls: number } | null;
  maxOutputTokens: number;
  signal: AbortSignal;
};

export type FunctionCall = { callId: string; name: string; arguments: string };
export type Citation = { url: string; title: string | null };

export type LlmStreamEvent =
  | { type: 'request_id'; id: string }
  | { type: 'text_delta'; text: string }
  | { type: 'web_search'; itemId: string; status: 'searching' | 'completed'; query?: string }
  | {
      type: 'completed';
      usage: UsageSnapshot;
      status: 'completed' | 'incomplete';
      incompleteReason?: string;
      /** Itens a reenviar como contexto na próxima chamada do mesmo run. */
      output: LlmItem[];
      functionCalls: FunctionCall[];
      citations: Citation[];
      webSearchCalls: number;
    };

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
