import { config } from '../config';
import { FakeAdapter } from './fake';
import { OpenAiAdapter } from './openai';
import type { LlmAdapter } from './types';

let override: LlmAdapter | undefined;

export function getLlm(provider: string): LlmAdapter {
  if (override) return override;
  const cfg = config();
  if (provider === 'openai') return new OpenAiAdapter(cfg.env.OPENAI_API_KEY!, cfg.env.OPENAI_REASONING_EFFORT);
  return new FakeAdapter(cfg.env.FAKE_LLM_DELAY_MS);
}

/** Somente testes. */
export function setLlmOverride(adapter: LlmAdapter | undefined) {
  override = adapter;
}
