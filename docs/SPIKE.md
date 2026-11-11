# Spike e resultados medidos

Registro do que foi verificado na prática, com data. Valores de modelo e preço vêm da conta e da página oficial, não da memória.

## Versões (10/11/2026)

| Componente | Versão |
|---|---|
| Node | 24.14 (imagem `node:24-bookworm-slim`) |
| Next.js / React | 16.4 / 19.3 |
| Postgres | 17 (Docker local) |
| pg-boss | 12.38 |
| Drizzle ORM / Kit | 0.45 / 0.31 |
| OpenAI SDK | 7.55 |
| MCP SDK | 1.32 (Streamable HTTP, cliente e servidor) |
| TypeScript | 5.9 (o 7.x ainda não é o compilador usado pelo Next) |

## Modelo e preços

- Modelos listados na conta via `GET /v1/models`: 45 modelos de chat.
- Escolhido: **`gpt-6-luna`**, com raciocínio `low`. Responses API, function calling, `web_search`, imagem e streaming confirmados na página do modelo.
- Preço oficial (Standard): US$ 0,10 de entrada, US$ 0,01 de entrada em cache e US$ 0,50 de saída por 1M tokens. Busca web: US$ 10 por 1k chamadas, mais os tokens de conteúdo da busca à taxa do modelo.

## Integrações verificadas com serviços reais

| Item | Resultado |
|---|---|
| Streaming Responses com `store:false` | ok |
| Busca nativa com `url_citation` → fonte citada | ok |
| Loop com function calls e reenvio de reasoning cifrado (`include: reasoning.encrypted_content`) | ok, sem erro de item ausente |
| Entrada de PDF (`input_file`) no `gpt-6-luna` | ok: código e total lidos de um PDF sintético |
| Compactação dupla e pergunta por fato antigo | ok |
| Login Google + conexões Drive/Gmail (Testing, test user) | ok; Gmail reporta 5 scopes por causa da autorização incremental |
| Leitura de Google Docs e de e-mail real | ok |
| Exfiltração via busca nativa com dado privado | **falha encontrada e corrigida** (DECISOES, Bloco 3) |
| Enqueue transacional pg-boss (`db.executeSql` no client da transação) | ok (testes) |
| Imagem Docker de produção | build ok (`docker build .`) |

## Medições (runs concluídos no ambiente local)

Gerado por `npm run metrics`, a partir de `run_events` e `usage_ledger`. "Até o 1º texto" conta desde a criação do run, incluindo fila.

| Perfil (gpt-6-luna) | Runs | Até o 1º texto (p50) | Duração (p50) | Custo médio |
|---|---|---|---|---|
| Só texto | 3 | 2,0–3,5 s | 2,5–4,0 s | US$ 0,0003 |
| Com busca web | 2 | 5,0 s | 5,5 s | US$ 0,0103 |
| Com tools (MCP, Drive, Gmail) | 3 | 12,4 s | 12,8 s | US$ 0,0007 |
| Com compactação | 2 | 8,1 s | 8,5 s | US$ 0,0007 |

- O polling do worker passou de 2 s (padrão do pg-boss) para 0,5 s. A espera na fila caiu para cerca de 260 ms e o tempo até o primeiro texto de uma resposta curta, de ~3,5 s para ~2,0 s.
- A busca web domina o custo: uma chamada custa ~14× uma resposta com várias tools.
- Gasto total com a OpenAI em todos os testes reais: **~US$ 0,03**.
- A amostra é pequena e local: são números de referência, não capacidade suportada.

## Limitações conhecidas

- Refresh real de token Google após expiração e o fluxo `reconnect_required` com revogação feita no Google foram cobertos por código e tipos, mas não exercitados com a conta real.
- Em modo Testing, o refresh token do Google expira em 7 dias: reconectar perto da avaliação.
- `scrape_page` não executa JavaScript; páginas dependentes de JS voltam vazias, com erro explícito.
