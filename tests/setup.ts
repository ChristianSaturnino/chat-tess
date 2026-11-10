// Testes usam o banco tess_test (Postgres real via docker compose).
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://tess:tess@localhost:5433/tess_test';
process.env.LLM_PROVIDER = 'fake';
process.env.FAKE_LLM_DELAY_MS = '0';
process.env.TURNS_PER_MINUTE = '1000';
process.env.LOG_LEVEL = 'silent';
process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.LOCAL_STORAGE_DIR = '.data/test-uploads';
process.env.SSRF_ALLOW_HOSTS = '';
process.env.DEMO_COMPACTION_TRIGGER_TOKENS = '600';
process.env.COMPACTION_TRIGGER_TOKENS = '600';
process.env.COMPACTION_KEEP_TURNS = '2';
process.env.ADMIN_EMAILS = 'admin@exemplo.test';
