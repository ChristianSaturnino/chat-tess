# Decisões tomadas na implementação

Registro de escolhas que refinam ou divergem do [PLANO.md](PLANO.md).

## Bloco 1

**Sessão própria em vez de Auth.js.** O plano previa Auth.js. Na implementação: login Google via `google-auth-library` (PKCE + state, verificação do `id_token`) e sessão própria (token aleatório no cookie, só o hash SHA-256 no banco). Motivos:
- O provider Credentials do Auth.js não usa sessões de banco; a demo isolada por visitante exigiria JWT ou contorno.
- O Auth.js v5 ainda está em beta na data do projeto.
- O Bloco 2 precisa de OAuth incremental para Drive/Gmail, com tokens cifrados e refresh serializado, que o Auth.js não resolve sozinho (PLANO §9). Um único cliente OAuth para login e conectores reduz superfície.
Custo aceito: menos código pronto para CSRF/rotação. Mitigação: cookie `httpOnly`/`SameSite=Lax`, checagem de `Origin` em toda mutação, expiração de 14 dias.

**Provider LLM `fake`.** Adapter determinístico, sem rede, com gatilhos `[[fail:4xx]]` e `[[fail:5xx]]` para exercitar cobrança/recuperação. Permite desenvolver e testar sem chave. Modelo e preços OpenAI vêm do `.env` (`OPENAI_MODEL`, `OPENAI_PRICING_JSON`): não são fixados no código.

**Recuperação.** Além dos retries do pg-boss, o worker varre a cada 15 s runs `running` com lease vencido e os reenfileira. O claim incrementa `runs.version` (fencing); toda escrita do engine confere a versão sob `FOR UPDATE`, então um worker antigo que volte não sobrescreve nada.

**Cancelamento com stream abortado** não recebe usage do provider: a reserva fica `unknown` (não liberada) até reconciliação, conforme PLANO §7.

**Append-only** de `usage_ledger` e `audit_events` por trigger (rejeita UPDATE/DELETE), independente do papel do banco.

## Bloco 2

**Loop de etapas com checkpoint por etapa.** Cada chamada ao modelo é uma etapa `llm_call` e cada tool pedida é uma etapa `tool_call`, com saída confirmada no checkpoint. Na retomada, o engine reconstrói o contexto do run a partir dos checkpoints e continua da primeira etapa pendente, sem repetir chamadas já confirmadas. Chamadas pedidas na mesma resposta são tratadas como independentes e rodam em paralelo (até 4).

**Ações com efeito externo nunca são repetidas automaticamente.** Tool HTTP `POST` (salvo declaração do dono) e tool MCP sem `readOnlyHint` contam como efeito externo. Se o worker cai durante uma delas, a etapa vira `unknown` e o modelo recebe "resultado desconhecido, não repetido". Leituras são reexecutadas.

**Política contra exfiltração por destino, não por instrução ao modelo.** Com dado privado na conversa (anexo, Drive ou Gmail), `scrape_page` só acessa URLs já obtidas como fonte nesta conversa, como as que vieram de uma busca. Tools HTTP e servidores MCP têm destino fixo cadastrado pelo dono e contam como destinos revisados. O bloqueio gera evento `policy_blocked` e auditoria. Uma etapa de aprovação manual (`waiting_approval`) ficou fora deste bloco.

**Fontes com rótulo por run.** Todo material obtido (anexo, página, arquivo do Drive, e-mail, resultado de tool) recebe um rótulo `S1`, `S2`… e entra no contexto com esse rótulo. Na finalização, só rótulos que existem no run contam como citados; os inventados pelo modelo são ignorados. Fontes consultadas e não citadas ficam visíveis separadamente. Citações `url_citation` da busca nativa viram fontes web.

**Busca nativa só com teto de custo.** A busca da OpenAI só é oferecida quando `OPENAI_WEB_SEARCH_FEE_MICRO` está configurado. A reserva inclui `max_tool_calls × tarifa`, e a liquidação registra as chamadas reais em colunas próprias do ledger. Sem tarifa conhecida, a busca fica indisponível, para não romper o cap estrito (PLANO §7).

**SSRF guard na conexão.** O IP é validado no `lookup` usado pelo agente HTTP, ou seja, no endereço efetivamente conectado, e não numa resolução anterior. Isso fecha a janela de DNS rebinding. Cada redirect é revalidado; headers sensíveis não seguem para outra origem; tools HTTP exigem https. Exceções de `localhost` só via `SSRF_ALLOW_HOSTS`, para desenvolvimento.

**MCP: uma sessão por run, uma reconexão.** Se o servidor invalida a sessão (404/400), o cliente reconecta uma vez. Tool ausente do catálogo dispara ressincronização e erro controlado. O catálogo só muda de versão quando o hash do conteúdo muda.

**Google: conexão separada do login.** Drive e Gmail são autorizados à parte, com `include_granted_scopes`, PKCE e scopes somente leitura. Tokens são cifrados com AES-256-GCM. O refresh é serializado por `FOR UPDATE` na linha da conexão e preserva o refresh token anterior quando o Google não envia outro. `invalid_grant` marca `reconnect_required`. PDF do Drive sem camada de texto devolve erro orientando enviar como anexo, em vez de fingir leitura.

**Anexos: tipo pelos bytes.** Só PNG, JPEG, GIF, WEBP e PDF, detectados pela assinatura do arquivo. Vão ao modelo como imagem/arquivo nativos, porque PDF escaneado precisa da análise visual e extração de texto não substitui. Em produção, R2 é obrigatório, já que web e worker não compartilham disco.

**Modelo: `gpt-6-luna` com raciocínio `low`.** É o modelo mais barato disponível na conta (US$ 0,10 / 0,01 / 0,50 por 1M tokens de entrada, cache e saída; página oficial consultada em 10/11/2026) e suporta Responses API, function calling, busca nativa e entrada de imagem. Tokens de raciocínio são cobrados como saída, por isso o esforço fica configurável (`OPENAI_REASONING_EFFORT`). A reserva da busca inclui tarifa (US$ 10 por 1k chamadas) e uma estimativa dos tokens de conteúdo injetados por busca (`WEB_SEARCH_TOKENS_PER_CALL`), que a página informa serem cobrados à taxa do modelo.

**Verificado com a OpenAI real (10/11/2026):** streaming de texto; busca nativa com `url_citation` virando fonte citada; loop de várias etapas com tools MCP e reenvio de reasoning cifrado com `store:false`, sem erro de item ausente. Custo do smoke test: 7 chamadas, US$ 0,012, dos quais US$ 0,01 foi a única busca.

## Bloco 3

**Compactação como etapa do run.** Antes da primeira chamada ao modelo, se a estimativa do contexto (memória atual + mensagens após o corte + anexos) passa do gatilho, as mensagens fora dos últimos turnos são resumidas. A compactação é uma etapa `compaction`, com tentativa, reserva e liquidação próprias, então aparece na execução e no consumo. A memória nova só vale depois de persistida (`context_summaries`, versionada, com corte por `seq`). Se falhar, o contexto anterior é mantido e a resposta segue. Pares de chamada/resultado de tools nunca são cortados, porque pertencem ao run em andamento e não ao histórico.

**Memória visível = memória usada.** O resumo é estruturado (fatos, decisões, pendências, preferências, materiais, narrativa) e o painel mostra exatamente o texto renderizado que o modelo recebe. Cada chamada registra a versão usada (`summaryVersion` em `attempt_started`). Optamos pelo resumo próprio em vez da compactação nativa da OpenAI porque o item nativo é opaco e não poderia ser exibido. Custo aceito: perda de informação e uma chamada extra.

**Contexto longo rejeitado pelo provider.** `context_length_exceeded` libera a reserva, força uma única compactação e permite uma nova tentativa. Se não houver o que compactar, o run falha com erro explícito, sem loop.

**Modo demo** usa um gatilho de compactação menor (`DEMO_COMPACTION_TRIGGER_TOKENS`) com o mesmo algoritmo, para exibir a compactação sem conversas enormes.

**Ver execução persistente.** A timeline vem de `run_events` e `tool_calls` (`/api/runs/:id/timeline`), então sobrevive a recarregar a página. Cada resposta tem um rodapé com chamadas, ferramentas, compactação, custo confirmado e duração. A timeline mostra ações observáveis, nunca o raciocínio do modelo.

**Compartilhamento.** O token aleatório (256 bits) aparece uma vez e o banco guarda só o hash. O snapshot grava a projeção pública no momento da criação. O live recalcula a cada acesso, é recusado na criação se a conversa tem dado privado e deixa de publicar se a conversa passar a ter. A projeção exclui argumentos e resultados de tools, itens do provider, reasoning e auditoria. Referências a Drive, Gmail e anexos aparecem só pelo título. Anexos só são baixáveis se marcados na prévia, e o download revalida o share a cada request, sem URL assinada que sobreviva à revogação.

**Cotas e auditoria.** O papel admin vem de `ADMIN_EMAILS`, com e-mail verificado pelo Google, nunca de dado do cliente. O ajuste de limite é auditado na mesma transação e não pode ficar abaixo do consumo confirmado + reservado. A auditoria é consultável pelo próprio usuário (eventos em que ele é ator) e por admin (todos).

**Markdown seguro.** As respostas são renderizadas com `react-markdown`, sem HTML cru. Imagens viram texto alternativo, para que nada seja carregado de origens externas, e links aceitam só http(s)/mailto.

**Verificado com a OpenAI real:** duas compactações sucessivas numa conversa com busca e tools; o modelo respondeu corretamente sobre fatos que só estavam na memória (versão do PostgreSQL e total do orçamento).

**Busca nativa também é saída de dados.** No teste real, com Drive e Gmail no contexto, pedimos para "abrir" uma URL com dados na query string. O modelo usou a busca nativa, que roda no provider e não passava pela política local, e a URL foi acessada. Correção: com dado privado na conversa, a busca nativa deixa de ser oferecida ao modelo naquela etapa (evento `policy_restricted`). O modelo passa a recorrer ao `scrape_page`, que a política bloqueia. Teste de regressão em `tests/tools.test.ts`.

**Verificado com Google real (10/11/2026), conta de teste dedicada:** login com papel admin via `ADMIN_EMAILS`; conexões Drive e Gmail separadas (autorização incremental, refresh token cifrado); cenário integrado lendo um Google Docs e um e-mail, consultando o catálogo MCP e calculando o orçamento, com as três fontes citadas e o total correto; bloqueio da tentativa de exfiltração; tela de cotas do admin.

**Ainda não verificado:** entrada de PDF no modelo escolhido (a página do modelo não lista explicitamente), refresh real após a expiração do access token e o fluxo `reconnect_required` com revogação feita no Google.
