import type { FunctionCall, LlmAdapter, LlmItem, LlmRequest, LlmStreamEvent } from './types';
import { LlmError } from './types';

/**
 * Provider determinístico para desenvolvimento e testes. Não chama rede.
 * Gatilhos no texto do usuário:
 * - [[fail:4xx]] / [[fail:5xx]]: falha antes / no meio do stream.
 * - [[tool:nome {"arg":1}]]: pede a chamada da tool (várias podem ser pedidas de uma vez).
 */
export class FakeAdapter implements LlmAdapter {
  readonly provider = 'fake';
  constructor(private readonly delayMs: number) {}

  private async *summarize(req: LlmRequest, text: string): AsyncIterable<LlmStreamEvent> {
    const out = fakeSummary(text);
    yield { type: 'text_delta', text: out };
    yield { type: 'completed', status: 'completed', usage: usage(req, Math.ceil(out.length / 4)), output: [], functionCalls: [], citations: [], webSearchCalls: 0 };
  }

  async *stream(req: LlmRequest): AsyncIterable<LlmStreamEvent> {
    const lastUserIdx = req.input.findLastIndex((i) => i.kind === 'message' && i.role === 'user');
    const lastUser = req.input[lastUserIdx] as Extract<LlmItem, { kind: 'message' }> | undefined;
    const userText = lastUser?.content.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
    if (userText.includes('[[fail:4xx]]')) throw new LlmError('http_400', 'falha simulada 4xx', 'not_billed', false);

    yield { type: 'request_id', id: `fake_${Date.now()}` };

    if (req.instructions.startsWith('COMPACTADOR_DE_CONTEXTO')) {
      yield* this.summarize(req, userText);
      return;
    }

    const after = req.input.slice(lastUserIdx + 1);
    const outputs = after.filter((i): i is Extract<LlmItem, { kind: 'function_call_output' }> => i.kind === 'function_call_output');
    const requested = parseToolRequests(userText).filter((r) => req.tools.some((t) => t.name === r.name));

    if (outputs.length === 0 && requested.length > 0) {
      const functionCalls: FunctionCall[] = requested.map((r, i) => ({ callId: `call_fake_${i}_${Date.now()}`, name: r.name, arguments: r.arguments }));
      yield {
        type: 'completed',
        status: 'completed',
        usage: usage(req, 20),
        output: functionCalls.map((c) => ({ kind: 'function_call', ...c })),
        functionCalls,
        citations: [],
        webSearchCalls: 0,
      };
      return;
    }

    const attachments = lastUser?.content.filter((p) => p.type !== 'text').map((p) => (p as { filename: string }).filename) ?? [];
    const labels = [...new Set(outputs.flatMap((o) => o.output.match(/\[S\d+\]/g) ?? []))];
    const turns = req.input.filter((m) => m.kind === 'message' && m.role === 'user').length;
    let answer = `Resposta simulada (turno ${turns}). Você escreveu: "${userText.slice(0, 200)}". `;
    if (attachments.length) answer += `Anexos recebidos: ${attachments.join(', ')}. `;
    if (outputs.length) {
      answer += `Consultei ${outputs.length} ferramenta(s). `;
      for (const o of outputs) answer += `Resultado: ${o.output.replace(/\s+/g, ' ').slice(0, 160)}. `;
      if (labels.length) answer += `Fontes: ${labels.join(' ')}.`;
    } else {
      answer += 'Este texto é gerado pelo provider fake para validar streaming, persistência e recuperação.';
    }

    const words = answer.split(/(?<= )/);
    let produced = 0;
    for (const [i, w] of words.entries()) {
      if (req.signal.aborted) throw new LlmError('aborted', 'chamada cancelada', 'unknown', false);
      if (userText.includes('[[fail:5xx]]') && i === Math.floor(words.length / 2)) {
        throw new LlmError('http_500', 'falha simulada no meio do stream', 'unknown', true);
      }
      if (this.delayMs > 0) await sleep(this.delayMs, req.signal);
      produced += w.length;
      yield { type: 'text_delta', text: w };
    }
    yield {
      type: 'completed',
      status: 'completed',
      usage: usage(req, Math.ceil(produced / 4)),
      output: [],
      functionCalls: [],
      citations: [],
      webSearchCalls: 0,
    };
  }
}

/**
 * Resumo determinístico: mantém os fatos da memória anterior e acrescenta cada mensagem do usuário
 * do trecho novo como fato. Suficiente para testar preservação entre compactações sucessivas.
 */
function fakeSummary(text: string) {
  const prevMatch = text.match(/MEMÓRIA ANTERIOR:\n(\{.*?\})\n\nTRECHO NOVO:/s);
  let facts: string[] = [];
  try {
    facts = prevMatch ? (JSON.parse(prevMatch[1]!).facts ?? []) : [];
  } catch {}
  for (const m of text.matchAll(/#\d+ Usuário: (.+)/g)) facts.push(m[1]!.slice(0, 200));
  return JSON.stringify({ facts, decisions: [], openQuestions: [], userPreferences: [], references: [], narrative: `Memória com ${facts.length} fato(s).` });
}

function parseToolRequests(text: string) {
  const out: { name: string; arguments: string }[] = [];
  for (const m of text.matchAll(/\[\[tool:([a-zA-Z0-9_-]+)\s*(\{.*?\})?\]\]/g)) {
    out.push({ name: m[1]!, arguments: m[2] ?? '{}' });
  }
  return out;
}

function usage(req: LlmRequest, outputTokens: number) {
  const chars =
    req.instructions.length +
    req.input.reduce((n, i) => {
      if (i.kind === 'message') return n + i.content.reduce((k, p) => k + (p.type === 'text' ? p.text.length : 1000), 0);
      if (i.kind === 'function_call_output') return n + i.output.length;
      if (i.kind === 'function_call') return n + i.arguments.length;
      return n;
    }, 0);
  return { inputTokens: Math.ceil(chars / 4), cachedInputTokens: 0, outputTokens, reasoningTokens: 0 };
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
