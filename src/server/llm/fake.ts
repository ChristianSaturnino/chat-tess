import type { LlmAdapter, LlmRequest, LlmStreamEvent } from './types';
import { LlmError } from './types';

/**
 * Provider determinístico para desenvolvimento e testes. Não chama rede.
 * Gatilhos no texto do usuário para exercitar falhas: [[fail:4xx]], [[fail:5xx]].
 */
export class FakeAdapter implements LlmAdapter {
  readonly provider = 'fake';
  constructor(private readonly delayMs: number) {}

  async *stream(req: LlmRequest): AsyncIterable<LlmStreamEvent> {
    const last = [...req.input].reverse().find((m) => m.role === 'user')?.content ?? '';
    if (last.includes('[[fail:4xx]]')) throw new LlmError('http_400', 'falha simulada 4xx', 'not_billed', false);

    yield { type: 'request_id', id: `fake_${Date.now()}` };
    const turns = req.input.filter((m) => m.role === 'user').length;
    const answer =
      `Resposta simulada (turno ${turns}). Você escreveu: "${last.slice(0, 200)}". ` +
      'Este texto é gerado pelo provider fake para validar streaming, persistência e recuperação.';
    const words = answer.split(/(?<= )/);
    let produced = 0;
    for (const [i, w] of words.entries()) {
      if (req.signal.aborted) throw new LlmError('aborted', 'chamada cancelada', 'unknown', false);
      if (last.includes('[[fail:5xx]]') && i === Math.floor(words.length / 2)) {
        throw new LlmError('http_500', 'falha simulada no meio do stream', 'unknown', true);
      }
      if (this.delayMs > 0) await sleep(this.delayMs, req.signal);
      produced += w.length;
      yield { type: 'text_delta', text: w };
    }
    const inputChars = req.instructions.length + req.input.reduce((n, m) => n + m.content.length, 0);
    yield {
      type: 'completed',
      status: 'completed',
      usage: { inputTokens: Math.ceil(inputChars / 4), cachedInputTokens: 0, outputTokens: Math.ceil(produced / 4), reasoningTokens: 0 },
    };
  }
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
