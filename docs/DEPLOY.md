# Deploy (Railway)

Uma imagem Docker serve três serviços. O comando de início define o papel de cada um. Postgres e o bucket de anexos são recursos do próprio Railway.

```text
Railway project
├── Postgres            banco, fila (pg-boss), eventos e consumo
├── uploads             bucket privado S3 para anexos (web e worker não compartilham disco)
├── web        → npm run start      domínio público, health check /api/health
├── worker     → npm run worker     sem domínio
└── mcp-demo   → npm run mcp-demo   domínio público, token obrigatório
```

## 1. Projeto e recursos

1. **New Project → Deploy from GitHub repo**, escolhendo este repositório. Esse primeiro serviço será o `web`.
2. **+ Create → Database → PostgreSQL**.
3. **+ Create → Bucket**, com o nome `uploads`. O bucket é privado; a aplicação lê e grava pelas credenciais.
4. **+ Create → GitHub Repo** duas vezes, com o mesmo repositório, para criar `worker` e `mcp-demo`.
5. Em cada serviço do repositório, abra **Settings**:

| Serviço | Custom start command | Pre-deploy command | Health check path | Networking |
|---|---|---|---|---|
| web | `npm run start` | `npm run db:migrate` | `/api/health` | Generate domain |
| worker | `npm run worker` | — | — | sem domínio |
| mcp-demo | `npm run mcp-demo` | — | — | Generate domain |

O Dockerfile é detectado automaticamente.

## 2. Variáveis de ambiente

Em **web** e **worker**, com os mesmos valores. As referências `${{...}}` são resolvidas pelo Railway.

```text
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
APP_URL=https://${{web.RAILWAY_PUBLIC_DOMAIN}}
APP_ENCRYPTION_KEY=<novo, ver abaixo>
LLM_PROVIDER=openai
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-6-luna
OPENAI_PRICING_JSON={"version":"gpt-6-luna-2026-11-10","input":100000,"cachedInput":10000,"output":500000}
OPENAI_REASONING_EFFORT=low
OPENAI_WEB_SEARCH_FEE_MICRO=10000
WEB_SEARCH_MAX_CALLS=1
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
ADMIN_EMAILS=<e-mail admin>
CREDITS_GLOBAL_LIMIT_MICRO=3000000
CREDITS_USER_LIMIT_MICRO=500000
CREDITS_DEMO_LIMIT_MICRO=150000
DEMO_MAX_SESSIONS_PER_HOUR=20
S3_ENDPOINT=${{uploads.ENDPOINT}}
S3_BUCKET=${{uploads.BUCKET}}
S3_REGION=${{uploads.REGION}}
S3_ACCESS_KEY_ID=${{uploads.ACCESS_KEY_ID}}
S3_SECRET_ACCESS_KEY=${{uploads.SECRET_ACCESS_KEY}}
```

Em **mcp-demo**:

```text
NODE_ENV=production
MCP_DEMO_TOKEN=<segredo aleatório>
```

- Gere `APP_ENCRYPTION_KEY` e `MCP_DEMO_TOKEN` no seu terminal com `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. A chave de produção deve ser diferente da local; trocá-la depois invalida tokens e secrets já gravados.
- Se a aba **Credentials** do bucket indicar URLs no estilo path, acrescente `S3_FORCE_PATH_STYLE=true`.
- `SSRF_ALLOW_HOSTS` fica **vazio** em produção. O MCP demo é acessado pelo domínio público, como qualquer servidor externo.
- Cotas: uma resposta com busca na web custa cerca de 10 créditos (US$ 0,01), e uma só de texto, menos de 1. Com 150 créditos, um visitante demo faz uns 15 pedidos com busca ou centenas sem. O cap global de 3.000 créditos (US$ 3) protege o saldo da conta; ajuste-o ao saldo real e use **/admin** para dar mais cota a um avaliador.

## 3. Google Cloud (mesmo projeto do ambiente local)

Em **Google Auth Platform → Clients**, no client já usado localmente ou num client novo:

- Authorized JavaScript origins: `https://<domínio-do-web>`
- Authorized redirect URIs:
  - `https://<domínio-do-web>/api/auth/google/callback`
  - `https://<domínio-do-web>/api/connections/google/callback`

Em **Público-alvo → Usuários de teste**, adicione os e-mails dos avaliadores. Só eles conseguem conectar Drive e Gmail. O login demo funciona para qualquer pessoa.

## 4. Depois do primeiro deploy

1. Abra `https://<web>/api/health`. Deve responder `{"ok":true}`.
2. Entre com a conta admin, abra **Conectores** e cadastre o MCP demo: URL `https://<mcp-demo>/mcp`, com o token definido.
3. Anexe uma imagem numa conversa: confirma que o bucket está gravando e que o worker consegue ler.
4. Conecte Drive e Gmail e rode o cenário do roteiro (`docs/ROTEIRO-VIDEO.md`).
5. Em **/admin**, confira o cap global e as cotas.

## 5. Custos e desativação

- Railway: três serviços pequenos, Postgres e bucket. Defina **usage limit** no workspace.
- OpenAI: o cap global do app (`CREDITS_GLOBAL_LIMIT_MICRO`) bloqueia antes de chamar o modelo. Configure também o limite de gasto no painel da OpenAI.
- Ao fim da janela de avaliação, apague o projeto no Railway, revogue a chave OpenAI e o client OAuth e remova os test users.
