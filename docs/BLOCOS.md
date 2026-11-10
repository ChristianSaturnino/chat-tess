# Chat Tess — blocos de desenvolvimento

Cada bloco termina com código rodando localmente, testes do bloco passando e uma lista curta do que revisar. Após revisão, um commit por bloco. Referências de seção apontam para [PLANO.md](PLANO.md).

## Bloco 1 — Fundação e núcleo de execução

Objetivo: uma mensagem vira um run durável executado pelo worker, com streaming que sobrevive a recarregar a página.

- Scaffold: Next.js (App Router) + worker Node no mesmo pacote, Tailwind, Docker Compose com Postgres, `.env.example`.
- Banco (Drizzle + migrations): users, sessions, conversations, messages, runs, run_steps, step_attempts, run_events, credit_accounts, credit_reservations, usage_ledger, audit_events.
- Identidade: login Google (somente identidade) e sessão demo isolada por visitante, com limite global de criação.
- Comando de turno (§5): POST com chave de idempotência; transação única cria mensagem, placeholder, run, evento e job pg-boss. Um run ativo por conversa.
- Worker: lease/versão (fencing), heartbeat, checkpoints, deltas em lote, cancelamento cooperativo, recuperação de run interrompido.
- LLM: adapter OpenAI Responses (`store:false`, streaming, usage) + adapter `fake` determinístico para testes/dev sem chave.
- Créditos (§7) mínimos: reserva usuário+global com ordem fixa de locks, liquidação única por tentativa, `unknown` em falha ambígua.
- SSE com cursor, heartbeat e reconexão; UI básica de chat (lista de conversas, mensagens, composer, cancelar).
- Auditoria mínima append-only na mesma transação das mutações.

Aceite: POST repetido não duplica; recarregar durante a resposta continua o mesmo run; matar o worker no meio deixa estado explícito e o run é retomado/encerrado sem texto concatenado; saldo insuficiente impede início.

## Bloco 2 — Tools, fontes e conectores

Objetivo: o modelo usa ferramentas sob uma política comum e cita fontes reais.

- ToolRegistry + política (§9): schema validado em runtime, autorização por conversa, limites de tempo/tamanho, `function_call`/`function_call_output`, paralelismo de tools independentes, checkpoints por tool.
- Web: busca nativa (eventos e citações normalizados) e `scrape_page` com SSRF guard completo.
- Tools HTTP cadastradas pelo usuário (secrets no servidor, teste, habilitação por conversa).
- MCP: cliente Streamable HTTP no worker, discovery paginado, catálogo versionado, bearer token; servidor MCP demonstrativo com dados sintéticos.
- Google: OAuth incremental separado do login, tokens cifrados, refresh serializado, `reconnect_required`; tools `drive_search`, `drive_read_file`, `gmail_search`, `gmail_read`.
- Anexos: storage privado (R2 / local em dev), validação de tipo real, imagem e PDF enviados ao modelo.
- Fontes: `sources`/`message_sources` e referências na resposta; política contra exfiltração quando há fontes privadas no contexto.

Aceite: cenário integrado (PDF + imagem + Gmail + Drive + web + MCP) responde com referências; URL privada/redirect para metadata bloqueados; OAuth revogado gera reconexão.

## Bloco 3 — Memória, execução inspecionável, créditos completos, share e auditoria

Objetivo: o diferencial de produto fica visível.

- Compactação (§8): orçamento por chamada, resumo estruturado versionado, preservação de pares de tools, modo demo com orçamento reduzido, painel **Memória**.
- **Ver execução**: timeline por resposta (etapas, tools, fontes, falhas, compactações, duração, consumo).
- Créditos completos: UI estimado/reservado/confirmado, cap global estrito, ajustes de cota pelo admin com auditoria.
- Share (§10): prévia, snapshot imutável, live com aviso (bloqueado com fontes privadas), token com hash, expiração e revogação, projeção pública sanitizada.
- Auditoria: consulta por escopo do usuário e visão admin.

Aceite: duas compactações sucessivas preservam fatos do caso de teste; cota bloqueia nova chamada; share revogado fica inacessível.

## Bloco 4 — Robustez, deploy e entrega

Objetivo: evidências reproduzíveis no ambiente público.

- Testes da §13 que faltarem (concorrência em Postgres real, falhas de worker, MCP mudando schema, injeção em documento, Playwright dos fluxos principais).
- Polimento de UX e estados de erro.
- Deploy Railway (web, worker, Postgres) + R2; segredos, redirect URIs, test users Google.
- README, diagrama, `docs/DECISOES.md`, `docs/SPIKE.md` com resultados medidos, roteiro do vídeo, data de desativação.

Aceite: sessão limpa no deploy reproduz o roteiro da §14.

## Dependências externas (o que só você consegue fazer)

| Quando | Item |
|---|---|
| Bloco 1 | `OPENAI_API_KEY`; projeto Google Cloud com OAuth client (redirect `http://localhost:3000/api/auth/google/callback`). |
| Bloco 2 | APIs Gmail/Drive habilitadas, tela de consentimento em Testing, test users; bucket R2. |
| Bloco 4 | Conta Railway, domínio/redirect público, acesso dos avaliadores. |
