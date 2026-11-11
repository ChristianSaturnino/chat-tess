import { defineConfig } from '@playwright/test';

const PORT = 3101;
const MCP_PORT = 3102;

/** Ambiente isolado: banco de teste, provider fake (sem custo) e build próprio do Next. */
const env = {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://tess:tess@localhost:5433/tess_test',
  APP_URL: `http://localhost:${PORT}`,
  LLM_PROVIDER: 'fake',
  // Lento o bastante para recarregar e cancelar no meio do streaming.
  FAKE_LLM_DELAY_MS: '200',
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  SSRF_ALLOW_HOSTS: `localhost:${MCP_PORT}`,
  DEMO_MAX_SESSIONS_PER_HOUR: '1000',
  TURNS_PER_MINUTE: '1000',
  LOCAL_STORAGE_DIR: '.data/e2e-uploads',
  NEXT_DIST_DIR: '.next-e2e',
  LOG_LEVEL: 'warn',
  OPENAI_API_KEY: '',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',
};

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  webServer: [
    { command: `npx next dev -p ${PORT}`, url: `http://localhost:${PORT}/api/health`, env, timeout: 120_000, reuseExistingServer: false },
    { command: 'npx tsx src/worker/index.ts', env: { ...env, LOG_LEVEL: 'info' }, wait: { stdout: /worker iniciado/ }, timeout: 60_000, reuseExistingServer: false },
    {
      command: 'npx tsx src/mcp-demo/server.ts',
      env: { ...env, MCP_DEMO_PORT: String(MCP_PORT) },
      wait: { stdout: /MCP demo em/ },
      timeout: 30_000,
      reuseExistingServer: false,
    },
  ],
});
