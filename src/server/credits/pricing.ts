import type { Pricing } from '../config';
import type { UsageSnapshot } from '@/db/schema';

const PER_MILLION = 1_000_000;

/**
 * Custo de tokens em micro-USD, arredondado para cima.
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

export type ReservationInput = {
  inputChars: number;
  /** Tokens estimados fora do texto (imagens, PDFs, schemas de tools). */
  extraInputTokens?: number;
  maxOutputTokens: number;
  webSearch?: { maxCalls: number; feeMicroPerCall: number; tokensPerCall?: number } | null;
};

/**
 * Reserva = entrada estimada sem cache (incluindo o conteúdo que cada busca injeta)
 * + saída máxima + teto de tarifas de busca nativa.
 */
export function reservationMicro(r: ReservationInput, pricing: Pricing): number {
  const searchTokens = r.webSearch ? r.webSearch.maxCalls * (r.webSearch.tokensPerCall ?? 0) : 0;
  const tokens = costMicro(
    {
      inputTokens: estimateInputTokens(r.inputChars) + (r.extraInputTokens ?? 0) + searchTokens,
      cachedInputTokens: 0,
      outputTokens: r.maxOutputTokens,
      reasoningTokens: 0,
    },
    pricing,
  );
  return tokens + (r.webSearch ? r.webSearch.maxCalls * r.webSearch.feeMicroPerCall : 0);
}

/** 1 crédito = US$ 0,001 = 1000 micro-USD. */
export const microToCredits = (micro: number) => micro / 1000;
