import type { Pricing } from '../config';
import type { UsageSnapshot } from '@/db/schema';

const PER_MILLION = 1_000_000;

/**
 * Custo em micro-USD, arredondado para cima.
 * - Tokens em cache são parte de input_tokens: cobrados à taxa de cache e removidos da taxa cheia.
 * - Reasoning tokens já estão contidos em output_tokens: não somar de novo.
 */
export function costMicro(usage: UsageSnapshot, pricing: Pricing): number {
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const uncached = usage.inputTokens - cached;
  const numerator = uncached * pricing.input + cached * pricing.cachedInput + usage.outputTokens * pricing.output;
  return Math.ceil(numerator / PER_MILLION);
}

/** Estimativa conservadora de tokens de entrada a partir de caracteres (sem tokenizer). */
export function estimateInputTokens(chars: number): number {
  // ~1 token a cada 3 caracteres (conservador para PT-BR) + overhead de instruções/mensagens.
  return Math.ceil(chars / 3) + 256;
}

/** Reserva = entrada estimada sem cache + saída máxima. */
export function reservationMicro(inputChars: number, maxOutputTokens: number, pricing: Pricing): number {
  return costMicro(
    { inputTokens: estimateInputTokens(inputChars), cachedInputTokens: 0, outputTokens: maxOutputTokens, reasoningTokens: 0 },
    pricing,
  );
}

/** 1 crédito = US$ 0,001 = 1000 micro-USD. */
export const microToCredits = (micro: number) => micro / 1000;
