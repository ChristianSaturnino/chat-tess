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

**Ainda não verificado:** OAuth e leitura real de Drive e Gmail (dependem do projeto Google Cloud) e entrada de PDF no modelo escolhido, que a página do modelo não lista explicitamente.
