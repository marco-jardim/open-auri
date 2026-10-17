# Observabilidade (T5.2)

Três fontes, todas sem dados pessoais:

1. **Workers Logs** com as nossas linhas JSON (registro de requisição, erros de API, jobs).
2. **Analytics Engine** (binding `METRICS`) com contadores de eventos de produto e de operação.
3. **Painel da Cloudflare** (requisições, erros, CPU, filas e DLQ).

O registro de acesso do Marco Civil (art. 15) é outra coisa: é cifrado, vai para a fila
`ACCESS_LOG_QUEUE` e fica no R2 (`web/src/lib/server/security/README.md`). Nada desta página lê,
copia ou mistura esse registro.

## Configuração

- `observability.enabled: true` e `logs.enabled: true` nos dois Workers (web e jobs), nos três
  ambientes do template (nível superior, `production`, `staging`).
- `logs.invocation_logs: false` e `redact_query_string: true` continuam como decidido na F3: os
  logs de invocação da plataforma gravam a URL completa, e links enviados por e-mail levam tokens
  na query (`/api/auth/verify-email?token=`, `/redefinir-senha?token=`). Só as nossas linhas vão
  para o Workers Logs.
- `analytics_engine_datasets`: binding `METRICS`, dataset `open_auri_metrics` (produção) e
  `open_auri_metrics_staging` (staging). O dataset nasce na primeira escrita. Sem o binding (testes,
  `vite dev`, configuração antiga) todas as funções de métrica viram no-op.
- Código: `web/src/lib/server/observability/` (`request-log.ts`, `metrics.ts`).

## Registro de requisição

Uma linha JSON por requisição dinâmica, escrita pelo handle `createRequestLogHandle` em
`hooks.server.ts` (logo depois do `platformShim`, para medir todos os outros hooks, incluindo o 503
do modo somente leitura). Respostas 5xx vão para `console.error`; o resto para `console.log`.

```json
{
  "event": "http.request",
  "id": "8f1e2d3c4b5a6978-GRU",
  "route": "/api/v1/curves/[id]",
  "method": "GET",
  "status": 404,
  "ms": 12,
  "code": "NOT_FOUND"
}
```

| Campo    | Conteúdo                                                                                     |
| -------- | -------------------------------------------------------------------------------------------- |
| `event`  | sempre `http.request`                                                                        |
| `id`     | valor do cabeçalho `cf-ray` quando tem o formato esperado; senão um UUID aleatório           |
| `route`  | id de rota do SvelteKit (`/curva/[id]`); `(unmatched)` quando nenhuma rota casou             |
| `method` | `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS` ou `OTHER`                        |
| `status` | status HTTP da resposta (500 quando o handler lançou exceção)                                |
| `ms`     | tempo de parede entre o hook e a resposta; o relógio do Worker só anda com E/S, então pode ser 0 |
| `code`   | opcional: código de erro em MAIÚSCULAS de uma resposta JSON de erro (`{ error: { code } }` da API, `{ code }` do Better Auth) |
| `error`  | opcional: nome da classe da exceção (`TypeError`), nunca a mensagem                          |

Nunca entram: URL, caminho com parâmetros, query string, IP, User-Agent, cookie, cabeçalho de
autorização, e-mail, token, id de usuário, corpo da requisição ou da resposta. Testes:
`web/tests/integration/observability/observability.test.ts`.

Outras linhas já existentes, no mesmo espírito: `api.error` (rota e código ou classe do erro),
`auth.session_lookup_failed`, `email.send failed` (modelo e tipo do erro), `job.failed` e as
linhas de contagem de cada job (`job.rotate_salt`, `job.regate` etc.).

## Métricas (Analytics Engine)

Esquema fixo, um ponto por evento:

| Coluna SQL | Origem         | Conteúdo                                                            |
| ---------- | -------------- | ------------------------------------------------------------------- |
| `index1`   | `indexes[0]`   | nome do evento (chave de amostragem)                                |
| `blob1`    | `blobs[0]`     | nome do evento (repetido, para filtrar e agrupar)                   |
| `blob2`    | `blobs[1]`     | rótulo principal (ver tabela abaixo)                                |
| `blob3`    | `blobs[2]`     | detalhe (ver tabela abaixo)                                         |
| `double1`  | `doubles[0]`   | sempre 1 (contagem)                                                 |
| `double2`  | `doubles[1]`   | valor: duração em ms (`job_run`), status HTTP (`http_5xx`), senão 0 |

| Evento          | `blob2`                          | `blob3`                                   | Onde é gravado                                                           |
| --------------- | -------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------ |
| `gate_rejected` | código do motivo do gate         | caminho: `publish`, `version` ou `fork`   | `social/curves.ts` (`prepare`), um ponto por motivo distinto (até 8)     |
| `signup`        | `email`                          | vazio                                     | `auth/hooks.ts`, hook `after` de `/sign-up/email` com sucesso            |
| `email_failed`  | modelo (tag `template`) ou `unknown` | tipo do erro (`suppressed`, `unexpected` etc.) | `email/index.ts` (`withFailureMetrics`, em todo `createEmailProvider`) |
| `http_5xx`      | id da rota da API                | código (`RATE_LIMIT_UNAVAILABLE`) ou classe do erro | `api/handler.ts` (`defineApi`)                                 |
| `report`        | tipo do alvo (`lineage`, `pack`, `user`) | motivo da denúncia                 | `social/moderation.ts` (`fileReport`, só denúncias novas)                |
| `job_run`       | nome do job                      | `ok` ou `failed`                          | `workers/jobs/src/jobs/registry.ts` (cron e fila)                        |

Rótulos que não são códigos curtos (mais de 96 caracteres, espaços, `@`, sequências de 6 ou mais
dígitos) são trocados por `other` antes da escrita, para que nenhum chamador grave texto livre,
e-mail ou id por engano. Uma falha de escrita gera só a linha `metrics.write_failed` (classe do
erro) e nunca interrompe a requisição ou o job.

O `http_5xx` cobre as rotas `/api/v1` (o wrapper `defineApi`). Erros 5xx de páginas e do Better
Auth aparecem no registro de requisição (`status` 5xx, em `console.error`).

### Consultas SQL de exemplo

A API SQL do Analytics Engine fica em
`https://api.cloudflare.com/client/v4/accounts/<ID da conta>/analytics_engine/sql` (POST com o
SQL no corpo e um token com permissão "Account Analytics: Read"). O ID da conta fica só no
`.env`. Os dados são amostrados: some sempre `_sample_interval`.

5xx por rota na última hora:

```sql
SELECT blob2 AS rota, blob3 AS codigo, SUM(_sample_interval * double1) AS total
FROM open_auri_metrics
WHERE index1 = 'http_5xx' AND timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY rota, codigo
ORDER BY total DESC
```

Rejeições do gate por motivo, por hora, nas últimas 24 horas:

```sql
SELECT toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS hora, blob2 AS motivo,
       SUM(_sample_interval * double1) AS total
FROM open_auri_metrics
WHERE index1 = 'gate_rejected' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY hora, motivo
ORDER BY hora, total DESC
```

Cadastros por dia (últimos 30 dias):

```sql
SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS dia, SUM(_sample_interval * double1) AS cadastros
FROM open_auri_metrics
WHERE index1 = 'signup' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY dia
ORDER BY dia
```

Falhas de e-mail por modelo e tipo (últimos 15 minutos, sem supressões):

```sql
SELECT blob2 AS modelo, blob3 AS tipo, SUM(_sample_interval * double1) AS falhas
FROM open_auri_metrics
WHERE index1 = 'email_failed' AND blob3 != 'suppressed' AND timestamp > NOW() - INTERVAL '15' MINUTE
GROUP BY modelo, tipo
```

Execuções de jobs nas últimas 24 horas (falhas e duração média):

```sql
SELECT blob2 AS job,
       SUM(IF(blob3 = 'failed', _sample_interval, 0)) AS falhas,
       SUM(_sample_interval) AS execucoes,
       SUM(_sample_interval * double2) / SUM(_sample_interval) AS ms_medio
FROM open_auri_metrics
WHERE index1 = 'job_run' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY job
ORDER BY falhas DESC
```

Denúncias por motivo (últimos 7 dias):

```sql
SELECT blob2 AS alvo, blob3 AS motivo, SUM(_sample_interval * double1) AS denuncias
FROM open_auri_metrics
WHERE index1 = 'report' AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY alvo, motivo
ORDER BY denuncias DESC
```

Para staging troque a tabela por `open_auri_metrics_staging`.

## Limiares de alerta

Valores iniciais para produção; revisar depois do primeiro mês com tráfego real. "Aviso" pede
olhar no mesmo dia; "crítico" pede ação imediata (ver `docs/operacao/` para os procedimentos).

| Sinal                     | Aviso                                                                    | Crítico                                                     | Fonte                                     |
| ------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------- | ----------------------------------------- |
| Taxa de 5xx               | mais de 1% das requisições em 5 min, ou 10 ou mais `http_5xx` em 5 min    | mais de 5% em 5 min, ou 50 ou mais `http_5xx` em 5 min       | painel do Worker (taxa); `http_5xx` (contagem) |
| Pico de rejeições do gate | na última hora, mais de 3 vezes a média horária dos 7 dias anteriores e pelo menos 20 rejeições | um único motivo com mais de 100 rejeições em 1 hora | `gate_rejected`                            |
| Falhas de e-mail          | 5 ou mais falhas (fora `suppressed`) em 15 min                            | 20 ou mais em 15 min, ou falhas em todos os envios de 15 min | `email_failed`                             |
| Falhas de jobs            | qualquer `job_run` com `failed`                                          | o mesmo job falhando em 2 execuções seguidas; `rotate-salt` falhando uma vez (o sal de amanhã precisa existir antes da meia-noite UTC) | `job_run` e linhas `job.failed`            |
| Profundidade da DLQ       | qualquer mensagem na DLQ do registro de acesso                           | mais de 100 mensagens, ou crescendo por 2 horas seguidas      | painel de Queues ou `wrangler queues info` |
| Cadastros                 | zero cadastros em 24 horas com `SIGNUP_ENABLED=true`                      |                                                             | `signup`                                  |
| Denúncias                 | mais de 20 denúncias em 1 hora                                           | mais de 100 em 1 hora (possível ataque à ocultação automática) | `report`                                   |

A Cloudflare não dispara alertas sobre o Analytics Engine sozinha: as consultas acima rodam por um
agendador do operador (ou manualmente na revisão diária). Para 5xx e filas existem notificações
nativas no painel (Notifications), que podem ser ligadas com os mesmos limiares.

## Como ler o Workers Logs

1. Painel da Cloudflare, Workers e Pages, escolher o Worker (web ou jobs, produção ou
   `-staging`), aba **Logs**.
2. Filtrar pelo campo `event`: `http.request` para o tráfego, `api.error` para erros da API,
   `job.failed` para jobs, `metrics.write_failed` para escritas de métrica que falharam.
3. Para uma requisição específica, filtrar por `id` (o `cf-ray` que aparece na página de erro ou
   no cabeçalho da resposta).
4. Para latência por rota, agrupar por `route` e olhar `ms` (lembrando que o relógio do Worker só
   anda com E/S).
5. Ao vivo: `npx wrangler tail <worker> --format json` (da pasta `web/` ou `workers/jobs/`).

Como os logs de invocação estão desligados, não há URL nem cabeçalhos da plataforma nos logs:
toda investigação parte de `id`, `route` e `code`. Isso é intencional (sem PII nos logs).
