# Roteiro do vídeo (≈ 5 minutos)

Preparação: conta Google de teste com o Doc `Requisitos Projeto Demo` e o e-mail `Requisitos de compra - demo`; MCP demo cadastrado; um PDF de orçamento e uma imagem de especificação à mão.

| # | Tempo | O que mostrar | Fala-chave |
|---|---|---|---|
| 1 | 0:00 | Tela inicial, **Conectores**: Drive e Gmail conectados (somente leitura), MCP demo com 2 tools | "Login é identidade; Drive e Gmail são autorizações separadas, só leitura." |
| 2 | 0:30 | Nova conversa, anexar PDF + imagem, pedir: comparar com o Doc e o e-mail, montar orçamento no catálogo e conferir um dado na web | "Uma resposta, várias fontes." |
| 3 | 1:15 | **Recarregar a página** no meio da resposta | "A execução está no worker, não na aba: a resposta continua no mesmo run." |
| 4 | 1:40 | Resposta com fontes citadas e consultadas; **Ver execução**: etapas, tools, duração, tokens, créditos | "A timeline mostra ações observáveis, não o raciocínio do modelo." |
| 5 | 2:20 | Pedir para enviar os dados para uma URL externa → bloqueado | "Com dado privado no contexto, a política bloqueia destino novo e tira a busca nativa da chamada." |
| 6 | 2:50 | Continuar até compactar; abrir **Memória** (versões); perguntar um fato antigo | "O resumo exibido é exatamente o que o modelo recebe." |
| 7 | 3:30 | **/admin**: reduzir a cota de um usuário; nova mensagem é bloqueada; **/audit** mostra o ajuste | "Reserva antes da chamada, liquidação única, cap global estrito." |
| 8 | 4:00 | **Compartilhar**: prévia, snapshot, abrir em janela anônima; revogar e recarregar | "Token com hash, projeção sanitizada, revogação imediata." |
| 9 | 4:30 | Diagrama do README | "Monólito modular com dois processos sobre Postgres." Limitação: "não prometo exatamente uma vez para efeitos externos: ambíguo vira 'desconhecido', nunca repetição automática." |

Dicas de gravação: modo escuro do sistema, zoom de 110%, painel "Ver execução" aberto ao lado da resposta.
