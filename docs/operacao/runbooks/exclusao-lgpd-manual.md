# Runbook: exclusão LGPD manual

## Quando usar

Um titular pede eliminação de dados (LGPD, art. 18, VI) pelo canal LGPD em vez de usar o
autoatendimento, ou não consegue usá-lo. Pedidos de acesso e portabilidade seguem a mesma triagem
e terminam na exportação JSON de `/conta`.

## O que existe e o que não existe

- **Autoatendimento (caminho preferido):** `/conta` > encerrar conta. O titular escolhe
  "anonimizar" (curvas públicas CC ficam com "autor removido", o apelido fica reservado por 90 dias)
  ou "apagar tudo". O conteúdo privado é sempre apagado. A confirmação chega por e-mail e a exclusão
  roda num único lote atômico (política de `web/src/lib/server/account/deletion.ts` e
  `web/src/lib/server/social/deletion.ts`).
- **Não há ferramenta administrativa de exclusão de conta.** Não apague linhas no D1 à mão: a
  política de exclusão toca várias tabelas na ordem certa, e SQL manual deixa dados órfãos ou apaga
  o que deveria ser anonimizado. Se o caso exigir exclusão sem o titular, abra uma tarefa para uma
  ferramenta do operador com testes (padrão `tools/*.mjs`) e responda ao titular dentro do prazo.
- **O que não se apaga a pedido:** registros de acesso (Marco Civil, 6 meses, LGPD art. 16, I),
  auditoria de moderação (5 anos) e versões já publicadas sob licença CC (licença irrevogável; o
  crédito pode ser anonimizado). Cópias em backups somem em até 12 semanas; uma restauração
  reaplica as exclusões registradas desde o backup.

## Pré-condições

- Pedido recebido pelo canal LGPD, registrado fora do repositório (data, canal, tipo de pedido).
- **Titularidade confirmada:** o pedido vem do e-mail da conta, ou o titular prova controle desse
  e-mail (por exemplo, respondendo a uma mensagem enviada a ele). Sem confirmação, não aja.

## Procedimento

1. **Titular com acesso à conta:** responda com o passo a passo: entrar, `/conta`, encerrar conta,
   escolher o modo, abrir o link de confirmação recebido por e-mail.
2. **Titular sem senha, mas com o e-mail:** oriente `/esqueci-senha` e depois o passo 1.
3. **Pedido parcial:**
   - atividade (experimentou, instalou, favoritou): o titular apaga em `/conta`;
   - uma curva específica: o titular retira a linhagem (lápide); se não conseguir, o operador
     retira em `/admin/moderacao` com motivo "pedido LGPD" ([`moderacao.md`](moderacao.md));
   - preferências anônimas do teste cego (S6): só com o recibo local do titular, pelo próprio app;
     sem recibo, o lote não é localizável (não tem conta nem IP).
4. **Titular sem acesso ao e-mail da conta, ou que não pode agir:**
   - bloqueie a conta enquanto o caso é tratado: `/admin/usuarios`, localize por e-mail exato,
     banir (revoga sessões, a conta some das listas);
   - retire o conteúdo público pela moderação, se pedido;
   - registre que a eliminação completa depende da ferramenta do operador e informe o titular do
     prazo.
5. Responda ao titular em até 15 dias (declaração completa, art. 19, II), dizendo o que foi apagado,
   o que foi anonimizado e o que fica retido e por quê (registros de acesso, auditoria, backups).

## Verificação

- Depois do encerramento, entrar com o e-mail da conta falha com a mensagem genérica.
- `<PUBLIC_ORIGIN>/u/<apelido>` responde 404 (ou mostra o apelido reservado sem conteúdo, no modo
  anonimizar); curvas públicas anonimizadas aparecem com "autor removido".
- `/admin/auditoria` mostra as ações administrativas feitas no caso.

## Rollback

Exclusão de conta é irreversível. Restaurar um backup para "desfazer" uma exclusão pedida pelo
titular não é permitido. Ações administrativas intermediárias (banimento, ocultação) se desfazem em
`/admin/usuarios` e `/admin/moderacao`.
