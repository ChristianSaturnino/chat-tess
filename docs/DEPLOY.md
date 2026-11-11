# Deploy (Railway + Cloudflare R2)

Uma imagem Docker serve três serviços. O comando de início define o papel de cada um. O Postgres é o do próprio Railway.

```text
Railway project
├── Postgres            (plugin do Railway)
├── web        → npm run start      domínio público, health check /api/health
├── worker     → npm run worker     sem domínio
└── mcp-demo   → npm run mcp-demo   domínio público, token obrigatório
Cloudflare R2 → bucket privado para anexos (web e worker não compartilham disco)
```

## 1. Cloudflare R2

1. Cloudflare → **R2** → **Create bucket** com o nome `chat-tess-uploads`, sem acesso público.
2. **R2 → Manage API tokens → Create API token**, com permissão **Object Read & Write** restrita a esse bucket.
3. Anote `Account ID`, `Access Key ID` e `Secret Access Key`. O secret só aparece uma vez.

## 2. Railway

1. **New Project → Deploy from GitHub repo**, escolhendo este repositório. Esse primeiro serviço será o `web`.
2. **+ New → Database → PostgreSQL**.
3. Duplique o serviço do repositório duas vezes e renomeie as cópias para `worker` e `mcp-demo`.
4. Em cada serviço, abra **Settings**:

| Serviço | Start command | Pre-deploy command | Health check | Domínio |
|---|---|---|---|---|
| web | `npm run start` | `npm run db:migrate` | `/api/health` | Generate domain |
| worker | `npm run worker` | — | — | não |
| mcp-demo | `npm run mcp-demo` | — | — | Generate domain |

O Dockerfile é detectado automaticamente.

## 3. Variáveis de ambiente

Em **web** e **worker**, com os mesmos valores. Use **Shared Variables** para não duplicar:

```text
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
APP_URL=https://<domínio-do-web>.up.railway.app
APP_ENCRYPTION_KEY=<novo: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))">
LLM_PROVIDER=openai
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-6-luna
OPENAI_PRICING_JSON={"version":"gpt-6-luna-2026-11-10","input":100000,"cachedInput":10000,"output":500000}
OPENAI_REASONING_EFFORT=low
OPENAI_WEB_SEARCH_FEE_MICRO=10000
WEB_SEARCH_MAX_CALLS=2
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
ADMIN_EMAILS=<e-mail admin>
CREDITS_GLOBAL_LIMIT_MICRO=2000000
CREDITS_USER_LIMIT_MICRO=300000
CREDITS_DEMO_LIMIT_MICRO=50000
DEMO_MAX_SESSIONS_PER_HOUR=20
R2_BUCKET=chat-tess-uploads
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
```

Em **mcp-demo**:

```text
NODE_ENV=production
MCP_DEMO_TOKEN=<segredo aleatório>
```

- `APP_ENCRYPTION_KEY` de produção deve ser diferente da local. Trocá-la depois invalida tokens e secrets já gravados.
- `SSRF_ALLOW_HOSTS` fica **vazio** em produção. O MCP demo é acessado pelo domínio público, como qualquer servidor externo.

## 4. Google Cloud (mesmo projeto do ambiente local)

Em **Google Auth Platform → Clients → chat-tess-local**, ou num client novo `chat-tess-prod`:

- Authorized JavaScript origins: `https://<domínio-do-web>`
- Authorized redirect URIs:
  - `https://<domínio-do-web>/api/auth/google/callback`
  - `https://<domínio-do-web>/api/connections/google/callback`

Em **Público-alvo → Usuários de teste**, adicione os e-mails dos avaliadores. Só eles conseguem conectar Drive e Gmail. O login demo funciona para qualquer pessoa.

## 5. Depois do primeiro deploy

1. Abra `https://<web>/api/health`. Deve responder `{"ok":true}`.
2. Entre com a conta admin, abra **Conectores** e cadastre o MCP demo: URL `https://<mcp-demo>/mcp`, com o token definido.
3. Conecte Drive e Gmail e rode o cenário do roteiro (`docs/ROTEIRO-VIDEO.md`).
4. Em **/admin**, confira o cap global e as cotas.

## 6. Custos e desativação

- Railway: três serviços pequenos + Postgres. Defina **usage limit** no projeto.
- OpenAI: o cap global do app (`CREDITS_GLOBAL_LIMIT_MICRO`) bloqueia antes de chamar o modelo. Configure também o limite de gasto no painel da OpenAI.
- Ao fim da janela de avaliação, apague o projeto no Railway e o bucket R2, revogue a chave OpenAI e o client OAuth, e remova os test users.
