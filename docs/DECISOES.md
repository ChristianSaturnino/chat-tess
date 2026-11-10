# Decisões tomadas na implementação

Registro de escolhas que refinam ou divergem do [PLANO.md](PLANO.md).

## Bloco 1

**Sessão própria em vez de Auth.js.** O plano previa Auth.js. Na implementação: login Google via `google-auth-library` (PKCE + state, verificação do `id_token`) e sessão própria (token aleatório no cookie, só o hash SHA-256 no banco). Motivos:
- O provider Credentials do Auth.js não usa sessões de banco; a demo isolada por visitante exigiria JWT ou contorno.
- O Auth.js v5 ainda está em beta na data do projeto.
- O Bloco 2 precisa de OAuth incremental para Drive/Gmail, com tokens cifrados e refresh serializado, que o Auth.js não resolve sozinho (PLANO §9). Um único cliente OAuth para login e conectores reduz superfície.
Custo aceito: menos código pronto para CSRF/rotação. Mitigação: cookie `httpOnly`/`SameSite=Lax`, checagem de `Origin` em toda mutação, expiração de 14 dias.

**Provider LLM `fake`.** Adapter determinístico, sem rede, com gatilhos `[[fail:4xx]]` e `[[fail:5xx]]` para exercitar cobrança/recuperação. Permite desenvolver e testar sem chave. Modelo e preços OpenAI vêm do `.env` (`OPENAI_MODEL`, `OPENAI_PRICING_JSON`): não são fixados no código.

**Apenas uma etapa LLM por run neste bloco.** O loop multi-etapa (tools) entra no Bloco 2 sobre a mesma estrutura de `run_steps`/`step_attempts`.

**Recuperação.** Além dos retries do pg-boss, o worker varre a cada 15 s runs `running` com lease vencido e os reenfileira. O claim incrementa `runs.version` (fencing); toda escrita do engine confere a versão sob `FOR UPDATE`, então um worker antigo que volte não sobrescreve nada.

**Cancelamento com stream abortado** não recebe usage do provider: a reserva fica `unknown` (não liberada) até reconciliação, conforme PLANO §7.

**Append-only** de `usage_ledger` e `audit_events` por trigger (rejeita UPDATE/DELETE), independente do papel do banco.
