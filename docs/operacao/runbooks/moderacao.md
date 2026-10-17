# Runbook: moderação

## Quando usar

- Há itens na fila de `/admin/moderacao` (denúncias abertas ou conteúdo ocultado automaticamente).
- Chegou pedido de revisão de ocultação automática (LGPD, art. 20) pelo canal LGPD.
- Chegou notificação de conteúdo ilícito ou que viola os termos (fora do app).

## Regras de fundo

- Denúncia exige conta verificada e Turnstile; cada conta denuncia um alvo uma vez.
- **Ocultação automática:** 3 contas verificadas distintas, com 3 dias ou mais de idade, denunciam o
  mesmo alvo. O conteúdo fica `auto_hidden` até revisão humana, que é obrigatória.
- Estados de moderação: `visible`, `auto_hidden`, `hidden`, `removed`. Conteúdo oculto ou retirado
  sai de feed, rankings, perfis, `/c/[id]`, OG e troca às cegas.
- Toda ação grava uma linha em `audit_log` com o ator, a ação, o alvo e o motivo.

## Pré-condições

- Conta com papel `admin` (concedido só por `tools/grant-admin.mjs`) e 2FA ligado em `/conta`.
- Se houver Cloudflare Access na frente de `/admin`, login no Access também.
- O modo somente leitura não bloqueia `/admin`: a moderação funciona durante um incidente.

## Procedimento

1. Abra `<PUBLIC_ORIGIN>/admin/moderacao`. A fila mostra o alvo, as denúncias, os motivos e o
   estado atual.
2. Abra o conteúdo denunciado pelo link do item e avalie contra os termos (`/termos`).
3. Escolha a ação no item, preencha o campo de motivo (texto curto, sem dados pessoais) e confirme:

   | Botão                              | Efeito                                                             | Quando                                                 |
   | ---------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------ |
   | Dispensar denúncias                | Fecha as denúncias; o conteúdo continua como está                  | Denúncia improcedente                                  |
   | Restaurar                          | Volta para `visible`                                               | Ocultação automática improcedente (revisão do art. 20) |
   | Ocultar                            | `hidden`: some das listas e das páginas públicas, o autor ainda vê | Violação leve ou dúvida que precisa de contato         |
   | Retirar                            | `removed`: retirada definitiva da exibição                         | Violação clara dos termos ou conteúdo ilícito          |
   | Marcar curadoria / Tirar curadoria | Destaque editorial                                                 | Fora do fluxo de denúncia                              |
   | Banir autor                        | Bane a conta pelo prazo escolhido em "Duração do banimento"        | Abuso reiterado, spam, contas de ataque                |

4. Para pedidos externos (ordem judicial de remoção, notificação de direitos), registre a
   referência no campo de motivo, sem nome de pessoas.
5. Para revisão pedida pelo canal LGPD, responda ao titular pelo mesmo canal com a decisão e a
   justificativa, em até 15 dias.

## Abuso em massa

Se uma onda de spam ou de denúncias falsas sobrecarregar a fila:

1. Ligue o modo somente leitura ([`somente-leitura.md`](somente-leitura.md)); `/admin` continua
   funcionando.
2. Banir as contas de origem pela fila (`/admin/usuarios` ajuda a localizar por apelido).
3. Trate a fila e desligue o modo somente leitura.
4. Se a origem for automatizada, siga também [`incidente.md`](incidente.md).

## Verificação

- O item sai da fila ou muda de estado em `/admin/moderacao`.
- `/admin/auditoria` mostra a ação com o seu ator e o motivo.
- Em uma janela anônima, `<PUBLIC_ORIGIN>/c/<id-da-linhagem>` responde 404 para conteúdo oculto ou
  retirado. Feed e rankings refletem a mudança no próximo cálculo (até 15 minutos; cache de 60 s).

## Rollback

- Ocultar ou retirar por engano: "Restaurar" no mesmo item.
- Banimento por engano: em `/admin/usuarios`, localize a conta (apelido ou e-mail exato) e
  desbana. Ações destrutivas pedem sessão recente: entre de novo se a página pedir. O banimento
  revoga as sessões da conta; o usuário entra de novo depois do desbanimento.
- A auditoria é só por acréscimo: o erro e a correção ficam registrados. Não apague linhas.
