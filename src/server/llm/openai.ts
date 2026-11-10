import OpenAI, { APIConnectionError, APIError, APIUserAbortError } from 'openai';
import type { ResponseInputItem, ResponseOutputItem, Tool } from 'openai/resources/responses/responses';
import type { Citation, ContentPart, FunctionCall, LlmAdapter, LlmItem, LlmRequest, LlmStreamEvent } from './types';
import { LlmError } from './types';

/**
 * Adapter da Responses API. Contexto é gerido pela aplicação (store:false);
 * isso não é garantia geral de ausência de retenção pelo provider.
 */
export class OpenAiAdapter implements LlmAdapter {
  readonly provider = 'openai';
  private client: OpenAI;

  constructor(
    apiKey: string,
    private readonly reasoningEffort?: 'none' | 'low' | 'medium' | 'high',
  ) {
    // Retries implícitos desabilitados: toda nova tentativa passa pelo engine e é contabilizada.
    this.client = new OpenAI({ apiKey, maxRetries: 0, timeout: 10 * 60 * 1000 });
  }

  async *stream(req: LlmRequest): AsyncIterable<LlmStreamEvent> {
    const tools: Tool[] = req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false }));
    if (req.webSearch) tools.push({ type: 'web_search' });

    let stream;
    try {
      stream = await this.client.responses.create(
        {
          model: req.model,
          instructions: req.instructions,
          input: req.input.map(toInput),
          tools: tools.length ? tools : undefined,
          // Teto de chamadas de tools nativas por resposta: limita a tarifa de busca reservada.
          max_tool_calls: req.webSearch ? req.webSearch.maxCalls : undefined,
          max_output_tokens: req.maxOutputTokens,
          reasoning: this.reasoningEffort ? { effort: this.reasoningEffort } : undefined,
          // Com store:false, o reasoning precisa voltar cifrado para continuar entre chamadas de tools.
          include: ['reasoning.encrypted_content'],
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
          case 'response.web_search_call.searching':
            yield { type: 'web_search', itemId: ev.item_id, status: 'searching' };
            break;
          case 'response.web_search_call.completed':
            yield { type: 'web_search', itemId: ev.item_id, status: 'completed' };
            break;
          case 'response.completed':
          case 'response.incomplete': {
            const r = ev.response;
            const u = r.usage;
            yield {
              type: 'completed',
              status: ev.type === 'response.completed' ? 'completed' : 'incomplete',
              incompleteReason: r.incomplete_details?.reason ?? undefined,
              usage: {
                inputTokens: u?.input_tokens ?? 0,
                cachedInputTokens: u?.input_tokens_details?.cached_tokens ?? 0,
                outputTokens: u?.output_tokens ?? 0,
                reasoningTokens: u?.output_tokens_details?.reasoning_tokens ?? 0,
              },
              ...fromOutput(r.output),
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

function toContent(part: ContentPart) {
  switch (part.type) {
    case 'text':
      return { type: 'input_text' as const, text: part.text };
    case 'image':
      return { type: 'input_image' as const, image_url: `data:${part.mimeType};base64,${part.dataBase64}`, detail: 'auto' as const };
    case 'file':
      return { type: 'input_file' as const, filename: part.filename, file_data: `data:${part.mimeType};base64,${part.dataBase64}` };
  }
}

function toInput(item: LlmItem): ResponseInputItem {
  switch (item.kind) {
    case 'message':
      if (item.role === 'assistant') {
        return { role: 'assistant', content: item.content.map((p) => (p.type === 'text' ? p.text : '')).join('') };
      }
      return { role: 'user', content: item.content.map(toContent) };
    case 'function_call':
      return { type: 'function_call', call_id: item.callId, name: item.name, arguments: item.arguments };
    case 'function_call_output':
      return { type: 'function_call_output', call_id: item.callId, output: item.output };
    case 'opaque':
      return item.item as ResponseInputItem;
  }
}

/**
 * Normaliza a saída: function calls para execução local, citações de busca nativa
 * e itens brutos para reenvio. IDs de itens não-reasoning são removidos porque, com
 * store:false, não existem do lado do provider.
 */
function fromOutput(output: ResponseOutputItem[]) {
  const items: LlmItem[] = [];
  const functionCalls: FunctionCall[] = [];
  const citations: Citation[] = [];
  let webSearchCalls = 0;
  for (const raw of output) {
    if (raw.type === 'function_call') functionCalls.push({ callId: raw.call_id, name: raw.name, arguments: raw.arguments });
    if (raw.type === 'web_search_call') webSearchCalls += 1;
    if (raw.type === 'message') {
      for (const c of raw.content) {
        if (c.type !== 'output_text') continue;
        for (const a of c.annotations ?? []) {
          if (a.type === 'url_citation') citations.push({ url: a.url, title: a.title ?? null });
        }
      }
    }
    const { id: _id, ...rest } = raw as unknown as { id?: string } & Record<string, unknown>;
    items.push({ kind: 'opaque', provider: 'openai', item: raw.type === 'reasoning' ? raw : rest });
  }
  return { output: items, functionCalls, citations, webSearchCalls };
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
