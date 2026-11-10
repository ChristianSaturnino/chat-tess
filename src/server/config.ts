import { z } from 'zod';

const intFromEnv = (def: number) => z.coerce.number().int().nonnegative().default(def);

const pricingSchema = z.object({
  version: z.string().min(1),
  /** micro-USD por 1M tokens */
  input: z.number().int().nonnegative(),
  cachedInput: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
});
export type Pricing = z.infer<typeof pricingSchema>;

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  DATABASE_URL: z.string().min(1),
  APP_URL: z.string().url().default('http://localhost:3000'),
  LLM_PROVIDER: z.enum(['fake', 'openai']).default('fake'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  OPENAI_PRICING_JSON: z.string().optional(),
  MAX_OUTPUT_TOKENS: intFromEnv(2048),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  CREDITS_USER_LIMIT_MICRO: intFromEnv(2_000_000),
  CREDITS_DEMO_LIMIT_MICRO: intFromEnv(200_000),
  CREDITS_GLOBAL_LIMIT_MICRO: intFromEnv(20_000_000),
  DEMO_MAX_SESSIONS_PER_HOUR: intFromEnv(30),
  TURNS_PER_MINUTE: intFromEnv(10),
  FAKE_LLM_DELAY_MS: intFromEnv(40),
  /** Tarifa por chamada de busca nativa, em micro-USD; sem valor, a busca fica indisponível. */
  OPENAI_WEB_SEARCH_FEE_MICRO: z.coerce.number().int().nonnegative().optional(),
  WEB_SEARCH_MAX_CALLS: intFromEnv(3),
  /** Conteúdo da busca é cobrado como tokens de entrada; estimativa por chamada para a reserva. */
  WEB_SEARCH_TOKENS_PER_CALL: intFromEnv(10_000),
  /** Esforço de raciocínio (modelos de reasoning); tokens de raciocínio são cobrados como saída. */
  OPENAI_REASONING_EFFORT: z.enum(['none', 'low', 'medium', 'high']).optional(),
  /** Compacta o histórico quando a estimativa de entrada passa deste valor. */
  COMPACTION_TRIGGER_TOKENS: intFromEnv(60_000),
  /** Visitantes demo usam um gatilho menor para exibir a compactação sem conversas longas. */
  DEMO_COMPACTION_TRIGGER_TOKENS: intFromEnv(2_500),
  /** Turnos mais recentes mantidos completos (inclui o atual). */
  COMPACTION_KEEP_TURNS: intFromEnv(2),
  /** E-mails Google com papel admin, separados por vírgula. */
  ADMIN_EMAILS: z.string().default(''),
  MAX_ITERATIONS: intFromEnv(6),
  MAX_TOOL_CALLS: intFromEnv(12),
});

export type LlmSettings = {
  provider: 'fake' | 'openai';
  model: string;
  pricing: Pricing;
  maxOutputTokens: number;
  maxLlmAttempts: number;
};

function load() {
  const env = envSchema.parse(process.env);

  let llm: LlmSettings;
  if (env.LLM_PROVIDER === 'openai') {
    // Modelo e preços vêm do ambiente, nunca de valores embutidos no código.
    if (!env.OPENAI_API_KEY || !env.OPENAI_MODEL || !env.OPENAI_PRICING_JSON) {
      throw new Error('LLM_PROVIDER=openai exige OPENAI_API_KEY, OPENAI_MODEL e OPENAI_PRICING_JSON');
    }
    llm = {
      provider: 'openai',
      model: env.OPENAI_MODEL,
      pricing: pricingSchema.parse(JSON.parse(env.OPENAI_PRICING_JSON)),
      maxOutputTokens: env.MAX_OUTPUT_TOKENS,
      maxLlmAttempts: 2,
    };
  } else {
    llm = {
      provider: 'fake',
      model: 'fake-echo',
      // Preço simbólico para exercitar reserva/liquidação sem custo real.
      pricing: { version: 'fake-1', input: 1_000_000, cachedInput: 100_000, output: 4_000_000 },
      maxOutputTokens: env.MAX_OUTPUT_TOKENS,
      maxLlmAttempts: 2,
    };
  }

  return {
    env,
    isProd: env.NODE_ENV === 'production',
    adminEmails: new Set(env.ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)),
    llm,
    credits: {
      userLimitMicro: env.CREDITS_USER_LIMIT_MICRO,
      demoLimitMicro: env.CREDITS_DEMO_LIMIT_MICRO,
      globalLimitMicro: env.CREDITS_GLOBAL_LIMIT_MICRO,
    },
    limits: {
      demoMaxSessionsPerHour: env.DEMO_MAX_SESSIONS_PER_HOUR,
      turnsPerMinute: env.TURNS_PER_MINUTE,
      maxMessageChars: 20_000,
      leaseSeconds: 30,
      heartbeatMs: 10_000,
      deltaFlushMs: 120,
      deltaFlushChars: 400,
      compactionTriggerTokens: env.COMPACTION_TRIGGER_TOKENS,
      demoCompactionTriggerTokens: env.DEMO_COMPACTION_TRIGGER_TOKENS,
      compactionKeepTurns: env.COMPACTION_KEEP_TURNS,
      maxIterations: env.MAX_ITERATIONS,
      maxToolCalls: env.MAX_TOOL_CALLS,
      toolConcurrency: 4,
    },
    /** Sob cap estrito, a busca só é oferecida com tarifa conhecida e teto de chamadas. */
    webSearch:
      llm.provider === 'openai' && env.OPENAI_WEB_SEARCH_FEE_MICRO !== undefined
        ? { maxCalls: env.WEB_SEARCH_MAX_CALLS, feeMicroPerCall: env.OPENAI_WEB_SEARCH_FEE_MICRO, tokensPerCall: env.WEB_SEARCH_TOKENS_PER_CALL }
        : null,
  };
}

export type AppConfig = ReturnType<typeof load>;
let cached: AppConfig | undefined;

export function config(): AppConfig {
  cached ??= load();
  return cached;
}

/** Somente para testes. */
export function resetConfigForTests() {
  cached = undefined;
}
