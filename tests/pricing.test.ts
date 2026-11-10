import { describe, expect, it } from 'vitest';
import { costMicro, reservationMicro } from '@/server/credits/pricing';

const pricing = { version: 't', input: 2_000_000, cachedInput: 500_000, output: 8_000_000 };

describe('costMicro', () => {
  it('cobra cache à taxa de cache sem somar de novo à entrada', () => {
    const c = costMicro({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 100, reasoningTokens: 0 }, pricing);
    expect(c).toBe(Math.ceil((600 * 2_000_000 + 400 * 500_000 + 100 * 8_000_000) / 1_000_000));
  });

  it('não conta reasoning duas vezes (já está em output)', () => {
    const a = costMicro({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 100, reasoningTokens: 0 }, pricing);
    const b = costMicro({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 100, reasoningTokens: 80 }, pricing);
    expect(a).toBe(b);
  });

  it('arredonda para cima e usa inteiros', () => {
    const c = costMicro({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 }, { ...pricing, input: 1 });
    expect(c).toBe(1);
    expect(Number.isInteger(c)).toBe(true);
  });

  it('reserva cobre a saída máxima', () => {
    expect(reservationMicro({ inputChars: 0, maxOutputTokens: 1000 }, pricing)).toBeGreaterThanOrEqual(1000 * 8);
  });

  it('reserva inclui o teto de tarifas da busca nativa', () => {
    const semBusca = reservationMicro({ inputChars: 100, maxOutputTokens: 100 }, pricing);
    const comBusca = reservationMicro({ inputChars: 100, maxOutputTokens: 100, webSearch: { maxCalls: 3, feeMicroPerCall: 10_000 } }, pricing);
    expect(comBusca - semBusca).toBe(30_000);
  });
});
