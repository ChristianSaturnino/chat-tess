import OpenAI, { APIConnectionError, APIError, APIUserAbortError } from 'openai';
import type { LlmAdapter, LlmRequest, LlmStreamEvent } from './types';
import { LlmError } from './types';

/**
 * Adapter mínimo da Responses API. Contexto é gerido pela aplicação (store:false);
 * isso não é garantia geral de ausência de retenção pelo provider.
 */
export class OpenAiAdapter implements LlmAdapter {
  readonly provider = 'openai';
  private client: OpenAI;

  constructor(apiKey: string) {
    // Retries implícitos desabilitados: toda nova tentativa passa pelo engine e é contabilizada.
    this.client = new OpenAI({ apiKey, maxRetries: 0, timeout: 10 * 60 * 1000 });
  }

  async *stream(req: LlmRequest): AsyncIterable<LlmStreamEvent> {
    let stream;
    try {
      stream = await this.client.responses.create(
        {
          model: req.model,
          instructions: req.instructions,
          input: req.input.map((m) => ({ role: m.role === 'system' ? 'developer' : m.role, content: m.content })),
          max_output_tokens: req.maxOutputTokens,
          store: false,
          stream: true,
        },
        { signal: req.signal },
      );
    } catch (err) {
      throw classify(err);
    }

    try {
      for await (const ev of stream) {
        switch (ev.type) {
          case 'response.created':
            yield { type: 'request_id', id: ev.response.id };
            break;
          case 'response.output_text.delta':
            yield { type: 'text_delta', text: ev.delta };
            break;
          case 'response.completed':
          case 'response.incomplete': {
            const u = ev.response.usage;
            yield {
              type: 'completed',
              status: ev.type === 'response.completed' ? 'completed' : 'incomplete',
              incompleteReason: ev.response.incomplete_details?.reason ?? undefined,
              usage: {
                inputTokens: u?.input_tokens ?? 0,
                cachedInputTokens: u?.input_tokens_details?.cached_tokens ?? 0,
                outputTokens: u?.output_tokens ?? 0,
                reasoningTokens: u?.output_tokens_details?.reasoning_tokens ?? 0,
              },
            };
            return;
          }
          case 'response.failed':
            throw new LlmError('provider_failed', ev.response.error?.message ?? 'falha no provider', 'unknown', true);
          case 'error':
            throw new LlmError('provider_error', ev.message, 'unknown', true);
          default:
            break;
        }
      }
    } catch (err) {
      throw classify(err);
    }
    throw new LlmError('stream_ended', 'stream encerrado sem conclusão', 'unknown', true);
  }
}

function classify(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  if (err instanceof APIUserAbortError) return new LlmError('aborted', 'chamada cancelada', 'unknown', false);
  if (err instanceof APIConnectionError) return new LlmError('connection', err.message, 'unknown', true);
  if (err instanceof APIError) {
    const status = err.status ?? 0;
    if (status === 429) return new LlmError('rate_limited', err.message, 'not_billed', true);
    if (status >= 400 && status < 500) return new LlmError(`http_${status}`, err.message, 'not_billed', false);
    return new LlmError(`http_${status}`, err.message, 'unknown', true);
  }
  return new LlmError('unexpected', err instanceof Error ? err.message : String(err), 'unknown', false);
}
