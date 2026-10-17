# Runbook: incidente

## Quando usar

- Erros 5xx, falhas de e-mail, jobs parados ou alertas de limiar disparados
  ([`../observabilidade.md`](../observabilidade.md)).
- Abuso (spam, força bruta, inundação de publicações ou de S6).
- Suspeita de vazamento de segredo, de dado pessoal no repositório ou de comprometimento de conta
  administrativa.
- Defeito que pode gravar algo errado no cabo (prioridade máxima: segurança do hardware e da
  audição vem antes de disponibilidade).

## Pré-condições

- Login OAuth do wrangler na conta de `CLOUDFLARE_ACCOUNT_ID` (`npx wrangler whoami`).
- Acesso a `/admin` (papel `admin` + 2FA).
- `.env` atualizado na máquina do operador.

## Procedimento

### 1. Conter (primeiros minutos)

1. Avalie se há escrita indevida em curso. Se sim, ligue o modo somente leitura
   ([`somente-leitura.md`](somente-leitura.md)). Leitura, navegação, editor e cabo continuam
   funcionando; só as escritas no servidor param.
2. Se o defeito estiver no código publicado, volte para a versão anterior do Worker:

   ```pwsh
   Set-Location web
   npx wrangler deployments list            # sem --env = produção; use --env staging no staging
   npx wrangler rollback <VERSION_ID> --message "<motivo curto>"
   Set-Location ..
   ```

   O mesmo para o Worker de jobs em `workers/jobs`. O rollback não desfaz migrações do D1; para
   dados, veja [`../backups.md`](../backups.md) (Time Travel e export).

3. Segredo vazado: rotacione na hora ([`rotacao-de-segredos.md`](rotacao-de-segredos.md)).
4. Conta administrativa comprometida: em `/admin/usuarios`, bana a conta (revoga as sessões); se for
   a única conta admin, rode `node tools/grant-admin.mjs --email <outro-endereco-do-operador>` para
   outra conta verificada antes. Reveja `/admin/auditoria` desde o início suspeito.
5. Dado pessoal ou segredo commitado no repositório público: remova no próximo commit, rotacione o
   segredo e trate o histórico (reescrita só com decisão explícita do controlador). Nunca cole o
   valor em issue, PR ou chat.

### 2. Diagnosticar

- Logs estruturados no Workers Logs (dashboard da Cloudflare, Worker web ou jobs). Os logs não têm
  dados pessoais: filtre por `code`, rota e id de requisição.
- Ao vivo:

  ```pwsh
  Set-Location web
  npx wrangler tail --format json            # Ctrl+C para sair; não salve a saída no repositório
  Set-Location ..
  ```

- Métricas e alertas: [`../observabilidade.md`](../observabilidade.md). Fila do registro de
  acesso e DLQ: dashboard de Queues.
- Reproduza em staging antes de corrigir.

### 3. Corrigir e voltar

1. Correção com teste que falhava antes, PR, CI verde, deploy pelo fluxo normal
   ([`docs/deploy.md`](../../deploy.md)), staging primeiro.
2. Desligue o modo somente leitura e confira o smoke.

### 4. Comunicar (LGPD, art. 48)

Se houve risco ou dano relevante a titulares (acesso indevido a dados de conta, vazamento):

1. Registre fatos, dados afetados, titulares afetados, medidas tomadas e horários.
2. O controlador decide a comunicação à ANPD e aos titulares conforme a Resolução CD/ANPD nº
   15/2024 (prazo de 3 dias úteis a partir do conhecimento). Titulares com conta são avisados por
   e-mail e por aviso no app ([`docs/lgpd.md`](../../lgpd.md), seção "Incidentes").
3. Guarde o registro do incidente fora do repositório público.

## Verificação

- Taxa de 5xx e alertas de volta ao normal; smoke do deploy passa.
- `/admin` mostra o modo somente leitura desligado.
- `node tools/check-sensitive.mjs` sai 0 depois de qualquer limpeza no repositório.

## Rollback

- `wrangler rollback` é reversível: rode de novo com o id da versão mais nova (veja
  `npx wrangler deployments list`) ou faça um deploy normal.
- O modo somente leitura desliga em `/admin` (ou pela chave de KV, ver
  [`somente-leitura.md`](somente-leitura.md)).

## Pós-incidente

Escreva uma revisão sem culpados (linha do tempo, causa, o que funcionou, o que mudar) e abra issues
para as ações, sem dados pessoais.
