# Operação do open-auri

Índice dos documentos de operação do serviço em produção (`https://open-auri.com`) e em staging
(`workers.dev`). Todos os comandos rodam na raiz do repositório, na máquina do operador, com o
login OAuth do wrangler (`npx wrangler login`) na conta de `CLOUDFLARE_ACCOUNT_ID` e o `.env`
preenchido. Nenhum valor do `.env` entra em documento, log, issue ou relatório.

## Referência

| Documento | Conteúdo |
|---|---|
| [`deploy.md`](deploy.md) | CI, deploy de staging e produção, migrações e smoke. |
| [`seguranca.md`](seguranca.md) | Cabeçalhos, CSP, modelo de ameaças, dependências e varredura de segredos. |
| [`operacao/observabilidade.md`](operacao/observabilidade.md) | Logs estruturados, métricas no Analytics Engine e alertas por limiar. |
| [`operacao/backups.md`](operacao/backups.md) | Export semanal do D1, dump público, job de limpeza e restauração. |
| [`operacao/capacidade.md`](operacao/capacidade.md) | Testes de carga, metas de latência e capacidade no Workers Paid. |
| [`lgpd.md`](lgpd.md) | Registro das operações de tratamento, retenções e direitos do titular. |
| [`api.md`](api.md) | Contrato da API v1 e códigos de erro (inclui `READ_ONLY`). |

## Runbooks

Cada runbook diz quando usar, pré-condições, comandos exatos (com placeholders), verificação e
rollback.

| Runbook | Quando usar |
|---|---|
| [`moderacao.md`](operacao/runbooks/moderacao.md) | Denúncias, ocultação automática, retirada de conteúdo e banimento. |
| [`incidente.md`](operacao/runbooks/incidente.md) | Falha, abuso, vazamento ou suspeita de comprometimento. |
| [`exclusao-lgpd-manual.md`](operacao/runbooks/exclusao-lgpd-manual.md) | Pedido de eliminação recebido pelo canal LGPD. |
| [`rotacao-de-segredos.md`](operacao/runbooks/rotacao-de-segredos.md) | Rotação planejada ou de emergência dos segredos dos Workers. |
| [`somente-leitura.md`](operacao/runbooks/somente-leitura.md) | Ligar e desligar o interruptor de emergência. |
| [`android-release.md`](operacao/runbooks/android-release.md) | Chaves, assinatura, Environment protegido, publicação Android, controles remotos de gravação e merge/deploy autônomos. |
| [`ordem-judicial.md`](operacao/runbooks/ordem-judicial.md) | Entrega de registros de acesso (Marco Civil) por ordem judicial. |
| [`ativacao-do-com.md`](operacao/runbooks/ativacao-do-com.md) | Levar a produção para `open-auri.com` e abrir o cadastro. |

## Convenções

- **Placeholders:** `<ASSIM>` é um valor que o operador conhece e nunca escreve em arquivo
  versionado. Em pwsh, valores do `.env` são lidos para variáveis de processo, nunca impressos.
- **Ambientes:** sem `--env`, as ferramentas miram o Worker de produção (nível superior do
  template); `--env staging` mira o staging. Teste todo procedimento em staging primeiro.
- **Ferramentas do operador** (`tools/*.mjs`): conferem o login com `wrangler whoami` contra
  `CLOUDFLARE_ACCOUNT_ID`, regeneram o `wrangler.jsonc` e nunca repassam a saída do wrangler.
  - `node tools/sync-secrets.mjs [--env staging|production] [--worker web|jobs]`
  - `node tools/grant-admin.mjs [--email <address>] [--create] [--force] [--operator <label>] [--env staging|production] [--local]`
  - `node tools/access-log-query.mjs --case <ref> --from <ISO> --to <ISO> --operator <id> --out <file.ndjson> [--env staging|production]`
  - `node tools/check-sensitive.mjs`
- **Auditoria:** toda ação administrativa e todo acesso aos registros de acesso ficam em
  `audit_log` (retenção de 5 anos), visível em `/admin/auditoria`.
- **Registro:** cada execução de runbook em produção é anotada (data, operador, motivo, resultado)
  no acompanhamento interno, sem dados pessoais.
