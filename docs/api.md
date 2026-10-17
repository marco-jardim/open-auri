# API v1 do open-auri

Contrato das rotas `/api/v1/**` do Worker web, mais a imagem OG (`/og/<versionId>.png`) e a página
compartilhada (`/c/<id>`). Fonte de verdade: o código em `web/src/routes/api/v1/**`, o kit em
`web/src/lib/server/api/**` (veja o `README.md` de lá) e os serviços em
`web/src/lib/server/social/**` (veja `web/src/lib/server/social/README.md`) e
`web/src/lib/server/og/**`. Se este documento e o código divergirem, vale o código; abra uma issue.

Fluxos de conta (cadastro, entrada, verificação, recuperação, troca de e-mail, 2FA) ficam em
`/api/auth/*` (Better Auth) e não fazem parte da v1. A exportação LGPD e o encerramento da conta
são ações da página `/conta`, também fora da v1.

## Convenções

### Ordem das checagens

Toda rota é montada com `defineApi`, que roda, nesta ordem:

1. **Somente leitura:** com o modo de manutenção ligado, o handle global responde 503 `READ_ONLY` a
   qualquer escrita antes de chegar à rota.
2. **Origem** (POST, PUT, PATCH, DELETE): o cabeçalho `Origin` precisa ser igual a `PUBLIC_ORIGIN`.
   Quando `PUBLIC_ORIGIN` é loopback, também valem `http://localhost:*` e `http://127.0.0.1:*`.
   `Origin` ausente, `null` ou de outro site: 403 `BAD_ORIGIN`. GET não é checado.
3. **Autenticação**, por nível:
   - `público`: com ou sem sessão (a sessão, se houver, só muda o que a visibilidade deixa ver);
   - `logado`: sessão válida, conta não banida (401 `AUTH_REQUIRED`, 403 `BANNED`);
   - `verificado`: logado e com e-mail verificado (403 `EMAIL_NOT_VERIFIED`);
   - `dono`: não é um nível do kit; o serviço confere a posse e responde 404 `NOT_FOUND` para o
     recurso de outra pessoa, igual a um recurso inexistente.
4. **Rate limit:** contador de rajada do Worker (`RL_API` para leituras, `RL_WRITE` para escritas),
   com chave `<grupo>` + id do usuário ou, sem sessão, + hash do IP com sal diário. Algumas rotas
   somam cotas em D1 (janela padrão de um dia). Excedido: 429 `RATE_LIMITED` com `retry-after` em
   segundos. Falha do contador, do sal ou do D1: 503 `RATE_LIMIT_UNAVAILABLE` (fecha por segurança).
   Os números da rajada vêm da configuração dos bindings, não do código das rotas.
5. **Turnstile** (só onde indicado): token no cabeçalho `x-turnstile-token`. Ausente, inválido, de
   outra ação ou impossível de verificar: 403 `TURNSTILE_FAILED`.
6. **Corpo:** `content-type: application/json` obrigatório (415 `UNSUPPORTED_MEDIA_TYPE`); limite
   padrão de 16 KiB, ou o indicado na rota (413 `PAYLOAD_TOO_LARGE`); JSON vazio, inválido, fora de
   UTF-8 ou reprovado no esquema zod: 400 `INVALID_BODY` com `details.issues: [{ path, code }]`.
7. **Handler.** Qualquer erro inesperado vira 500 `INTERNAL` e uma linha de log sem dados pessoais.

### Envelope de erro

```json
{ "error": { "code": "NOT_FOUND", "details": {} } }
```

`details` é opcional. Resposta de erro sempre com `content-type: application/json; charset=utf-8`
e `cache-control: no-store`. Nenhum erro ecoa entrada do usuário, e-mail, IP ou token. Os códigos
são estáveis: novos podem ser acrescentados, nenhum é renomeado ou reutilizado.

| Código                   | Status | Quando                                                                                     |
| ------------------------ | ------ | ------------------------------------------------------------------------------------------ |
| `INVALID_BODY`           | 400    | Corpo ou query inválidos; `details.issues: [{ path, code }]` quando há detalhe             |
| `INVALID_CURSOR`         | 400    | Cursor de paginação que não decodifica                                                     |
| `CONSENT_REQUIRED`       | 400    | Lote S6 sem a versão atual do consentimento                                                |
| `AUTH_REQUIRED`          | 401    | Sem sessão                                                                                 |
| `BAD_ORIGIN`             | 403    | Escrita sem `Origin` igual à origem pública                                                |
| `EMAIL_NOT_VERIFIED`     | 403    | Rota `verificado` com e-mail não verificado                                                |
| `BANNED`                 | 403    | Conta banida                                                                               |
| `FORBIDDEN`              | 403    | Recusa específica da rota (ex.: denunciar o próprio conteúdo)                              |
| `REAUTH_REQUIRED`        | 403    | Ação administrativa destrutiva com sessão de mais de 10 minutos                            |
| `TURNSTILE_FAILED`       | 403    | Token Turnstile ausente, inválido ou de outra ação                                         |
| `NOT_FOUND`              | 404    | Inexistente, sem permissão de leitura, ou de outra pessoa (mesma resposta nos três casos)  |
| `CONFLICT`               | 409    | Estado não permite a ação (linhagem retirada, troca não pareada, licença divergente)       |
| `HEAD_MOVED`             | 409    | Nova versão cujo pai já não é o head da linhagem                                           |
| `ALREADY_ACTIVE`         | 409    | Já existe uma troca S7 ativa deste usuário                                                 |
| `DUPLICATE`              | 409    | Recurso único já existe (segunda denúncia do mesmo alvo, recibo S6 repetido, nota repetida) |
| `GONE`                   | 410    | Linhagem retirada (lápide) lida por quem não é o dono                                      |
| `PAYLOAD_TOO_LARGE`      | 413    | Corpo acima do limite da rota                                                              |
| `UNSUPPORTED_MEDIA_TYPE` | 415    | Corpo sem `content-type: application/json`                                                 |
| `INVALID_CURVE`          | 422    | S5/S1 que não decodifica ou não valida; `details.codes` com códigos `s1:*` / `env:*`       |
| `GATE_REJECTED`          | 422    | Curva reprovada no gate v2; `details.reasons` com os códigos de motivo do gate             |
| `RATE_LIMITED`           | 429    | Rajada ou cota do kit excedida; `retry-after` em segundos                                  |
| `QUOTA_EXCEEDED`         | 429    | Cota de domínio excedida (publicações ou tentativas de gate); no merge, recusa por item    |
| `INTERNAL`               | 500    | Qualquer outro erro                                                                        |
| `RATE_LIMIT_UNAVAILABLE` | 503    | Contador, sal ou D1 indisponíveis                                                          |
| `READ_ONLY`              | 503    | Modo somente leitura ligado (handle global)                                                |

### Paginação

Listas respondem `{ items, nextCursor }` (algumas rotas acrescentam campos, indicados abaixo).
Para a próxima página, repita a requisição com `?cursor=<nextCursor>`; `nextCursor: null` marca a
última. O cursor é opaco (base64url), validado ao decodificar: não monte nem altere. `limit` vai de
1 a 100, padrão 20. Feed e rankings reduzem valores acima de 100; `/me/library`, `/me/packs` e
`/me/shares` recusam limites fora de 1 a 100 com 400 `INVALID_BODY`. Cursor inválido: 400
`INVALID_CURSOR`; `limit` mal formado: 400 `INVALID_BODY` nas rotas que validam a query.

### Cache e ETag

- Padrão de toda resposta JSON: `cache-control: private, no-store`.
- Leituras públicas marcadas com **60 s**: `cache-control: public, max-age=60, s-maxage=60` e
  `ETag` forte (SHA-256 do corpo). `If-None-Match` igual responde 304 sem corpo.
- **Imagem OG:** `cache-control: public, max-age=86400` com `ETag`, sem `immutable`. O servidor
  revalida a visibilidade antes de servir, inclusive em acertos do R2 e respostas 304; cópias já
  guardadas no navegador ou CDN podem durar até um dia.
- Onde a resposta depende da sessão (curvas e linhagens lidas logado, pack do próprio dono), ela
  volta como `private, no-store`.

### Tipos comuns

- Horários são epoch em milissegundos (número inteiro), salvo campos ISO explicitados, como
  `generatedAt` de S6. Ids são strings opacas.
- `AuthorCredit`: `{ username, displayUsername }`, só o apelido; `null` para "autor removido".
- `FeedLineageCard`: `{ id, curated, forked, author, createdAt, updatedAt, head, curve }`.
  `head = { id, name, description, license, lang, createdAt }`, com `license` ∈
  `CC0-1.0` | `CC-BY-4.0`; `curve = { id, s1, levelDb }`; `author` é `AuthorCredit` ou `null`.
  Não inclui `ownerUserId`, `canonKey`, versão ou motivos do gate, receita, visibilidade, estado
  ou moderação. `forked` é um booleano, não o id da versão de origem.
- `PublicRankingEntry`: `{ rank, score, computedAt, lineage: FeedLineageCard }`.
- O id interno de usuário nunca aparece numa resposta pública; o crédito é só o apelido.

### Visibilidade

- **Pública e listável:** `visibility = public`, linhagem ativa, sem ocultação de moderação, curva
  do head aprovada no gate atual e dono não banido. Só essas aparecem em feed, rankings, perfis,
  packs de outras pessoas e buscas.
- **Não listada:** abre por id, nunca é listada.
- **Privada:** só o dono. Para qualquer outra pessoa a resposta é 404, igual a um id inexistente.
- **Leituras por id e gate:** curvas, histórico, `/c`, OG e S7 reavaliam pareceres desatualizados
  antes de servir os dados. O head determina se a linhagem pode abrir por link; a curva de uma
  versão pedida também é reavaliada. Reprovação atual impede a leitura pública; S7 aplica sua
  regra própria de elegibilidade, descrita abaixo. Listas usam os pareceres armazenados e são
  atualizadas pelo job de reavaliação; não executam o gate para cada item da página.

## Índice

| Método e rota                                 | Auth               | Turnstile | Grupo de rate limit e cotas                     |
| --------------------------------------------- | ------------------ | --------- | ----------------------------------------------- |
| `GET /api/v1/feed`                            | público            | não       | `api.feed.read`                                 |
| `GET /api/v1/rankings`                        | público            | não       | `api.rankings.read`                             |
| `POST /api/v1/curves`                         | verificado         | não       | `api.curves.write`; 30 publicações e 60 tentativas de gate/dia |
| `GET /api/v1/curves/:id`                      | público            | não       | `api.curves.read`                               |
| `GET /api/v1/lineages/:id`                    | público            | não       | `api.lineages.read`                             |
| `POST /api/v1/lineages/:id/versions`          | verificado, dono   | não       | `api.lineages.write`; mesmas cotas de publicação e gate |
| `POST /api/v1/lineages/:id/fork`              | verificado         | não       | `api.lineages.write`; mesmas cotas de publicação e gate |
| `POST /api/v1/lineages/:id/retract`           | logado, dono       | não       | `api.lineages.write`                            |
| `POST /api/v1/lineages/:id/restore`           | verificado, dono   | não       | `api.lineages.write`                            |
| `PUT /api/v1/lineages/:id/visibility`         | verificado, dono   | não       | `api.lineages.write`                            |
| `PUT /api/v1/curves/:id/favorite`             | verificado         | não       | `api.curves.favorite`                           |
| `DELETE /api/v1/curves/:id/favorite`          | verificado         | não       | `api.curves.favorite`                           |
| `POST /api/v1/curves/:id/activity`            | verificado         | não       | `api.activity.write`; 120/h e 1000/dia          |
| `GET /api/v1/curves/:id/audience`             | logado, dono       | não       | `api.curves.audience`                           |
| `GET /api/v1/me/activity`                     | logado             | não       | `api.me.activity.read`                          |
| `DELETE /api/v1/me/activity`                  | logado             | não       | `api.me.activity.delete`                        |
| `POST /api/v1/me/activity/outbox`             | verificado         | não       | `api.activity.outbox`; 30 lotes/h e 100 lotes/dia; 1000 eventos/dia compartilhados |
| `GET /api/v1/me/library`                      | logado             | não       | `api.me.library.read`                           |
| `POST /api/v1/me/library/merge`               | verificado         | não       | `api.me.library.merge`; 50/dia; 500 criações e 500 itens na etapa de gate/24 h; 20 gates sem cache/requisição |
| `GET /api/v1/me/packs`                        | logado             | não       | `api.me.packs.read`                             |
| `GET /api/v1/me/shares`                       | logado             | não       | `api.me.shares.read`                            |
| `POST /api/v1/shares`                         | verificado         | não       | `api.shares.create`; 200/dia                    |
| `GET /api/v1/shares/:id/stats`                | logado, criador do share e dono da linhagem | não | `api.shares.stats`                    |
| `POST /api/v1/shares/:id/open`                | público            | não       | `api.shares.open` (escrita); 300/dia            |
| `GET /api/v1/users/:apelido`                  | público            | não       | `api.users.read`                                |
| `POST /api/v1/packs`                          | verificado         | não       | `api.packs.write`; 50/dia                       |
| `GET /api/v1/packs/:id`                       | público            | não       | `api.packs.read`                                |
| `PUT /api/v1/packs/:id`                       | verificado, dono   | não       | `api.packs.write`                               |
| `DELETE /api/v1/packs/:id`                    | logado, dono       | não       | `api.packs.write`                               |
| `POST /api/v1/reports`                        | verificado         | `report`  | `api.reports`; 30/dia                           |
| `POST /api/v1/s6/batches`                     | público (anônimo)  | `s6`      | `api.s6.submit` (só rajada, por hash de IP)     |
| `DELETE /api/v1/s6/batches/:receipt`          | público (anônimo)  | não       | `api.s6.delete` (só rajada, por hash de IP)     |
| `GET /api/v1/s6/preferences`                  | público            | não       | `api.s6.read`                                   |
| `POST /api/v1/trades`                         | verificado         | não       | `api.trades.join`                               |
| `GET /api/v1/trades/me`                       | verificado         | não       | `api.trades.read`                               |
| `DELETE /api/v1/trades/:id`                   | verificado, dono   | não       | `api.trades.cancel`                             |
| `POST /api/v1/trades/:id/score`               | verificado, dono   | não       | `api.trades.score`                              |
| `GET /og/:versionId.png`                      | público            | não       | `og` (leitura, só quando renderiza)             |
| `GET /c/:id`                                  | público            | não       | contagem de abertura: regra de `shares.open`    |

"30 publicações/dia" é uma cota única por usuário e dia UTC que soma publicações, novas versões e
forks bem-sucedidos. Além dela, as três rotas compartilham uma cota de 60 tentativas que chegam à
etapa de gate por usuário em janela móvel de 24 h, aprovadas ou recusadas, mesmo com parecer em
cache. O limite responde 429 `QUOTA_EXCEEDED` com `details.limit` e `retry-after`; falha do contador:
503 `RATE_LIMIT_UNAVAILABLE`. Toda escrita também passa pelo contador de rajada `RL_WRITE`; toda
leitura, pelo `RL_API`.

## Feed e rankings

### `GET /api/v1/feed`

Query: `sort` ∈ `new` (padrão) | `favorites` | `installs`; `window` ∈ `7d` (padrão) | `30d` |
`all` (ignorada em `new`); `cursor`; `limit` (1 a 3 dígitos, limitado a 100).

- `new`: linhagens públicas e listáveis mais novas, consulta ao vivo.
- `favorites` / `installs`: o ranking materializado da janela.

Resposta 200, cache de 60 s com ETag:

```json
{
  "sort": "favorites",
  "window": "7d",
  "computedAt": 1760000000000,
  "items": [{ "lineage": { "…": "FeedLineageCard" }, "rank": 1, "score": 12 }],
  "nextCursor": null
}
```

Em `new`, `window`, `computedAt`, `rank` e `score` são `null`. Erros: 400 `INVALID_BODY`
(`details.issues[0].path` = parâmetro), 400 `INVALID_CURSOR`.

### `GET /api/v1/rankings`

Query: `metric` ∈ `favorites` (padrão) | `installs`; `window` ∈ `7d` (padrão) | `30d` | `all`;
`cursor`; `limit`.

Resposta 200, cache de 60 s com ETag:
`{ metric, window, computedAt, items: PublicRankingEntry[], nextCursor }`.
Cada `lineage` é um `FeedLineageCard`, nunca o `LineageSummary` interno do repositório.
`computedAt` da página é `null` antes da primeira execução. Erros como no feed.

Regras (job a cada 15 minutos, `recomputeRankings`):

- pontuação = número de usuários **distintos** com e-mail verificado, não banidos, que favoritaram
  ou instalaram dentro da janela; o dono da linhagem nunca conta;
- só linhagens públicas e listáveis; não listadas e privadas nunca entram;
- desempate: pontuação, depois o evento mais recente, depois o id;
- até 1000 posições por métrica e janela;
- a visibilidade é conferida de novo na leitura: uma linhagem ocultada ou retirada depois da última
  execução some na hora.

## Curvas e linhagens

Uma **linhagem** é a curva publicada com todo o seu histórico; cada **versão** aponta para uma
curva (`curveId(s1)`, endereçada pelo conteúdo). Versões só se acrescentam.

### `POST /api/v1/curves`

Publica um envelope S5 (com o S1 dentro) como nova linhagem. Verificado; corpo até 32 KiB.

```json
{ "envelope": { "format": "open-auri/preset@1", "…": "…" }, "visibility": "public" }
```

Caminho: cota de publicações → `validateEnvelope` do núcleo (texto normalizado com NFKC, sem
invisíveis e bidi, sem URL; S1 igual às bandas) → cota de tentativas de gate → gate v2 no servidor
(cacheado por curva e versão do gate) → gravação. O envelope normalizado tem no máximo 8 KiB.
As cotas de 30 publicações/dia UTC e 60 tentativas/24 h são as mesmas para publicação, versão e fork.

- 201 `{ lineageId, versionId, curveId }`. Pública ou não listada aquece a imagem OG em segundo
  plano.
- 400 `INVALID_BODY`; 422 `INVALID_CURVE` (`details.codes`); 422 `GATE_REJECTED`
  (`details.reasons`); 429 `QUOTA_EXCEEDED` com `retry-after` até o fim do dia UTC para publicações
  ou até liberar a janela móvel para tentativas de gate (`details.limit` = 30 ou 60).

### `GET /api/v1/curves/:id?v=<versionId>`

`:id` é o id da linhagem; `v` escolhe uma versão (padrão: o head). Público, respeitando a
visibilidade da sessão. Reavalia o head e a versão pedida se o parecer do gate estiver
desatualizado, depois relê a visibilidade; reprovação atual impede leitura por terceiros.

- 200 com a linhagem, a versão pedida, a curva, as contagens públicas (`favorites`, `previewed`,
  `installed`) e o crédito do autor. Sem sessão: cache de 60 s com ETag; com sessão:
  `private, no-store`.
- 404 `NOT_FOUND` (inexistente, privada de outra pessoa ou moderada); 410 `GONE` (retirada, para
  quem não é o dono).

### `GET /api/v1/lineages/:id?cursor=&limit=`

Histórico de versões de uma linhagem legível, mais nova primeiro, paginado. Cache, 404 e 410 como
em `GET /api/v1/curves/:id`.

### `POST /api/v1/lineages/:id/versions`

Dono, verificado; corpo até 32 KiB: `{ "parentVersionId": "<head atual>", "envelope": { … } }`.
Usa as mesmas cotas de 30 publicações/dia UTC e 60 tentativas de gate/24 h da publicação.

- 201 `{ lineageId, versionId, curveId }`.
- 404 (não é dono ou não existe); 409 `HEAD_MOVED` (o pai não é mais o head: recarregue e
  reaplique); 409 `CONFLICT` (linhagem retirada); 422 `INVALID_CURVE` / `GATE_REJECTED`; 429
  `QUOTA_EXCEEDED`.

### `POST /api/v1/lineages/:id/fork`

Verificado; corpo até 32 KiB: `{ "versionId"?: "…", "visibility"?: "private", "envelope"?: { … } }`.
`{}` copia o head; a visibilidade padrão é privada. A origem precisa ser legível pela sessão. O
envelope novo, se enviado, passa pelo mesmo caminho de publicação. A cópia sem envelope também
é validada e passa pela etapa de gate, com as mesmas cotas de 30 publicações/dia UTC e 60
tentativas/24 h.

- 201 `{ lineageId, versionId, curveId, forkedFrom: { lineageId, versionId }, attribution }`.
  `attribution` traz licença, linhagem, versão, nome e autor quando a origem é CC-BY 4.0 (crédito
  obrigatório); `null` para CC0.
- 404; 410 `GONE` (origem retirada); 422; 429 `QUOTA_EXCEEDED`.

### `POST /api/v1/lineages/:id/retract`

Dono, só logado (tirar conteúdo do ar não exige e-mail verificado); sem corpo. Vira lápide: some
das listas e responde 410 a quem não é o dono. 200 com o estado
`{ lineageId, status, visibility, moderation }`; 404.

### `POST /api/v1/lineages/:id/restore`

Dono, verificado; sem corpo. Desfaz a lápide; a moderação não muda. O head é reavaliado no gate
antes de voltar a aparecer. 200 com o estado; 404; 422 `GATE_REJECTED`.

### `PUT /api/v1/lineages/:id/visibility`

Dono, verificado; corpo `{ "visibility": "private" | "unlisted" | "public" }`. Abrir a linhagem
reavalia o head no gate. 200 com o estado; 404; 409 `CONFLICT`; 422 `GATE_REJECTED`.

## Favoritos, atividade e público

### `PUT /api/v1/curves/:id/favorite` e `DELETE /api/v1/curves/:id/favorite`

`:id` é o id da linhagem. Verificado; idempotentes; sem corpo.

- PUT `?s=<shareId>` opcional: atribui um evento `favorited` ao funil quando o compartilhamento
  aponta para a mesma linhagem, o favorito é novo e o ator tem atividade pública. Atividade
  privada nunca é atribuída. 200 `{ "favorited": true, "created": boolean }`; 404 quando a
  linhagem não é legível.
- DELETE remove só a linha do próprio usuário e nunca revela se a linhagem existe:
  200 `{ "favorited": false, "removed": boolean }`.

### `POST /api/v1/curves/:id/activity`

Um evento do usuário verificado na linhagem `:id`. Corpo até 2 KiB:

```json
{
  "kind": "previewed",
  "eventId": "7d3f0c3e-0d55-4c55-9b7e-1f2a3b4c5d6e",
  "durationMs": 12000,
  "at": 1760000000000,
  "shareId": "opcional"
}
```

- `kind` ∈ `previewed` ("experimentou": prévia audível de pelo menos 10 s, `durationMs ≥ 10000`)
  | `installed` ("instalou": gravação real bem-sucedida no cabo, declarada pelo navegador).
- `eventId` (UUID escolhido pelo cliente) torna a repetição idempotente por 8 dias.
- `at` padrão: agora; aceito entre 7 dias atrás e 60 s no futuro. `durationMs` até um dia.
- `shareId`: com um compartilhamento da mesma linhagem, feito por outra pessoa, registra o evento
  atribuído uma vez por tipo, somente se o ator tem atividade pública. Atividade privada nunca é
  atribuída.

Respostas: 201 `{ "status": "recorded", "activity": { lineageId, kind, firstAt, lastAt, count } }`;
200 `{ "status": "duplicate" }`; 400 `INVALID_BODY` (`details.issues` com `preview_too_short` ou
`at_out_of_window`); 404. Cada usuário guarda uma linha por linhagem e tipo; repetir só aumenta o
`count` privado. Números públicos contam usuários distintos.

### `GET /api/v1/curves/:id/audience`

Dono, logado. 200 `{ "audience": { "previewed": G, "installed": G, "favorited": G } }`, com
`G = { total, named: [{ username, displayUsername, at }], privateCount }`: `total` = usuários
distintos verificados e não banidos (o dono fora); `named` só com perfil de atividade público (até
50, mais recentes primeiro, com apelido); `privateCount` = usuários elegíveis com atividade privada
ou sem apelido ("N pessoas com perfil privado"), sem incluir os públicos com apelido que ficaram
fora do limite de nomes. Decisão aceita: o `privateCount` do público do autor permanece exato
(plano §3.7). 404 para linhagem de outra pessoa ou inexistente.

### `GET /api/v1/me/activity` e `DELETE /api/v1/me/activity`

Logado.

- GET `?cursor=&limit=`: `{ items: [{ lineageId, kind, firstAt, lastAt, count }], nextCursor }`.
- DELETE `?lineageId=&kind=` (filtros opcionais; sem filtro apaga tudo): `{ "deleted": n }`. Os
  eventos atribuídos a compartilhamentos que casam com o filtro também saem, e as contagens
  públicas caem na hora; os rankings, no próximo recálculo.
- 400 `INVALID_BODY` (parâmetro inválido); 400 `INVALID_CURSOR`.

### `POST /api/v1/me/activity/outbox`

Fila offline enviada em lote. Verificado; corpo até 32 KiB: `{ "actor"?: "<id da própria conta>",
"events": [ … ] }`, de 1 a 50 itens no formato de `POST /curves/:id/activity` mais `lineageId`.
`actor` é opcional por compatibilidade, mas o cliente deve informar a conta que enfileirou os
eventos. Se for diferente da sessão: 409 `CONFLICT`, `details.reason = "actor-mismatch"`, sem
registrar nenhum item. Cada item é validado e aceito ou recusado sozinho.

200 `{ "results": [{ "index": 0, "eventId": "…", "status": "recorded" | "duplicate" | "rejected" |
"limited", "reason"?: "invalid" | "too-short" | "out-of-window" | "not-found" }] }`.
`eventId` vem `null` se o item não trouxer um UUID válido. Cada item que passa pelas checagens
iniciais consome uma unidade da cota diária de 1000 eventos por usuário, compartilhada com
`POST /curves/:id/activity`, inclusive antes de detectar duplicata. Ao esgotar a cota, os itens
que passariam nessas checagens recebem `limited`, sem gravar nem reservar o `eventId`; o cliente
deve guardá-los e tentar depois. As cotas de 30 lotes/h e 100 lotes/dia continuam separadas.

## Biblioteca

### `GET /api/v1/me/library`

Logado. Query: `shelf` ∈ `created` | `favorites` | `installed` (obrigatório); `visibility`
(filtra só `created`); `cursor` (até 512 caracteres); `limit` (1 a 100).
200 `{ shelf, items, nextCursor }`; 400 `INVALID_BODY` com `details.issues`; 400
`INVALID_CURSOR`.

### `GET /api/v1/me/packs`

Os pacotes do próprio usuário, em qualquer visibilidade, do mais novo para o mais antigo.
Logado. Query: `cursor` (até 512 caracteres); `limit` (1 a 100).
200 `{ items: [{ id, name, description, visibility, moderation, createdAt, updatedAt }],
nextCursor }`; 400 `INVALID_BODY` com `details.issues`; 400 `INVALID_CURSOR`.

### `GET /api/v1/me/shares`

Os links de compartilhamento do próprio usuário, do mais novo para o mais antigo, sem dados de
quem abriu (o funil fica em `GET /shares/:id/stats`, só para compartilhamentos de linhagem própria).
Logado. Query: `cursor` (até 512 caracteres); `limit` (1 a 100).
200 `{ items: [{ id, lineage: { id, name }, versionId, channel, createdAt }], nextCursor }`;
`lineage.name` é o nome da versão head e vem `null` quando o usuário não consegue mais ler a
linhagem. 400 `INVALID_BODY` com `details.issues`; 400 `INVALID_CURSOR`.

### `POST /api/v1/me/library/merge`

Mescla a biblioteca local (anônima) do navegador na conta, sem duplicar. Verificado; corpo até
1 MiB: `{ "items": [{ "localId", "s1", "name", "description"?, "lang"?, "license"? }] }`, de 1 a
100 itens com `localId` distintos. Itens novos passam pela validação e pelo gate; os criados
viram linhagens privadas. Duplicatas e conflitos de nome são identificados sem criar outra linhagem.

200 `{ created, duplicates, rejected, conflicts }`. Recusas por item usam `INVALID_CURVE`,
`GATE_REJECTED`, `INVALID_TEXT`, `QUOTA_EXCEEDED`, `DUPLICATE` ou `INTERNAL`.

- 50 requisições por dia, pelo kit (429 `RATE_LIMITED`).
- Limite de 500 linhagens criadas nas últimas 24 h para criar mais pelo merge.
- Contador separado de até 500 itens que chegam à etapa de gate por usuário em janela móvel de
  24 h, aprovados ou recusados, com ou sem cache; falha do contador: 503 `RATE_LIMIT_UNAVAILABLE`.
- No máximo 20 execuções de gate sem cache por requisição. Quando outro item exigiria a 21ª
  execução, ele e os itens novos restantes que precisariam passar por essa etapa recebem
  `QUOTA_EXCEEDED` no relatório. Esgotar os limites diários também recusa por item com esse código,
  sem transformar o relatório inteiro em erro HTTP. O cliente mantém esses itens locais e tenta
  depois.

## Compartilhamentos

### `POST /api/v1/shares`

Verificado; 200 por dia. Corpo `{ "lineageId", "versionId"?, "channel"? }` com `channel` ∈
`link` | `qr` | `whatsapp` | `x` | `email` | `other`. A linhagem precisa ser pública, não listada
ou do próprio usuário. 201 `{ shareId, url }`, com `url = /c/<lineageId>?s=<shareId>`;
404.

### `GET /api/v1/shares/:id/stats`

Somente quem criou o compartilhamento **e** é dono da linhagem, logado. Quem compartilhou uma
linhagem de outra pessoa também recebe 404, sem acesso nem às aberturas anônimas.

200 `{ shareId, opens: { total, days: [{ day, count }] }, attributed: { previewed, installed,
favorited } }`. `opens` contém só aberturas anônimas por dia UTC, mais antigo primeiro.
`attributed` conta usuários distintos por tipo, somente enquanto continuam elegíveis: atividade
pública, e-mail verificado e não banidos. Quem depois torna a atividade privada ou é banido deixa
de contar na leitura, inclusive em eventos antigos.
Não há nomes, ids de usuários nem contadores de atividade privada nesse funil. Compartilhamento
inexistente ou qualquer outro chamador: 404.

### `POST /api/v1/shares/:id/open`

Público, sem corpo. Soma 1 ao contador anônimo diário de aberturas; nada que identifique é
guardado. Rajada `RL_WRITE` e cota de 300 por dia por usuário ou hash de IP. 204; 404.

## Perfis e packs

### `GET /api/v1/users/:apelido`

Público; cache de 60 s com ETag.

- Sem `list`: apelido, bio, `libraryVisibility`, `activityVisibility`, contagens agregadas e a
  primeira página de cada lista pública (`null` nas listas que não são públicas).
- `?list=lineages|packs|favorites&cursor=&limit=`: `{ list, items, nextCursor }` (vazio quando a
  lista não é pública). `lineages` e `packs` exigem biblioteca pública; `favorites` exige também
  atividade pública.
- Apelido antigo ainda reservado (90 dias) ou outra grafia do mesmo apelido: 308 com
  `location: /api/v1/users/<atual>` e corpo `{ "redirect": "<atual>" }`.
- Desconhecido, liberado ou banido: 404. `list` ou `limit` inválidos: 400 `INVALID_BODY`; cursor
  inválido: 400 `INVALID_CURSOR`.

### `POST /api/v1/packs`

Verificado; corpo até 32 KiB; 50 por dia (`QUOTA_EXCEEDED` no limite do serviço).

```json
{
  "name": "Pack v1",
  "description": "opcional",
  "visibility": "public",
  "items": ["<lineageId>", { "lineageId": "<lineageId>", "license": "CC-BY-4.0" }]
}
```

Até 100 itens. A licença de cada item é copiada da versão head; se enviada, precisa ser igual
(409 `CONFLICT` com `details.reason = "license-mismatch"` e `index`). Item inexistente ou ilegível:
404 com `details.index`. Textos normalizados como na publicação. 201 com o pack.

### `GET /api/v1/packs/:id`

Público. Legível quando público ou não listado, sem moderação e com dono não banido, ou quando é do
próprio usuário. O pack de outra pessoa só lista linhagens públicas e listáveis. Leitura pública:
cache de 60 s com ETag; leitura do dono: `private, no-store`. 404.

### `PUT /api/v1/packs/:id` e `DELETE /api/v1/packs/:id`

Dono. PUT (verificado, até 32 KiB): `{ name?, description?, visibility?, items? }`; `items`
substitui a lista na ordem dada. 200 com o pack. DELETE (logado): 204. Pack de outra pessoa: 404.

## Moderação

### `POST /api/v1/reports`

Verificado; Turnstile `report`; 30 por dia; corpo até 4 KiB.

```json
{ "targetKind": "lineage", "targetId": "<id>", "reason": "spam", "note": "opcional" }
```

- `targetKind` ∈ `lineage` | `pack` | `user`; para `lineage`/`pack`, `targetId` é o id com
  `[A-Za-z0-9_-]{1,64}`; para `user`, é o **nickname público**, não o id interno da conta
  (aceita ponto e resolve variações e nicknames anteriores ainda reservados no servidor). `reason` ∈
  `dangerous` | `spam` | `offensive` | `copyright` | `impersonation` | `other`; `note` até 500
  caracteres, sem caracteres de controle, lida só por administradores.
- 201 `{ "reported": true }`; 404 (alvo inexistente ou ilegível, nickname desconhecido ou conta
  banida, inclusive tentativas por id interno, sem distinguir esses casos); 403 `FORBIDDEN` (o próprio
  conteúdo ou perfil); 409 `DUPLICATE` (segunda denúncia do mesmo alvo); 400 `INVALID_BODY`.
- Ocultação automática: quando 3 contas distintas, verificadas, não banidas e com 3 dias ou mais
  denunciam a mesma linhagem ou pack ainda visível, o alvo passa a `auto_hidden`, com registro de
  auditoria do sistema. Nunca desfaz uma decisão de administrador. A resposta não revela a
  ocultação. Perfis não são ocultados automaticamente.
- A revisão (ocultar, restaurar, remover, dispensar, banir o autor, curadoria) acontece em
  `/admin`, fora da v1, com auditoria e sessão recente para remover e banir.

## S6: preferências anônimas

### `POST /api/v1/s6/batches`

Público e anônimo: a sessão, se houver, é ignorada. O rate limit roda dentro da rota, sempre pelo
hash do IP com sal diário e só no contador de rajada, sem cota em D1 (nada sobre quem envia é
gravado). Depois o Turnstile (`s6`) e o corpo (limite padrão de 16 KiB):

```json
{
  "consentVersion": "s6-consent-v1",
  "receipt": "<43 caracteres base64url: 32 bytes aleatórios gerados no navegador>",
  "pairs": [{ "a": "<curveId>", "b": "<curveId>", "choice": "a", "levelMatched": true }]
}
```

- `pairs`: 1 a 100; `a` e `b` com `[a-z0-9._-]{1,64}` e diferentes; `choice` ∈ `a` | `b` | `tie`.
- Cada item precisa ser o `curveId` de um preset oficial ou a curva HEAD de uma linhagem pública
  e listável. Curva apenas histórica, privada, não listada, ocultada ou sem linhagem elegível não
  basta. Um único item inelegível recusa o lote inteiro: 400 `INVALID_BODY`,
  `details.issues = [{ path: ["pairs"], code: "s6_unknown_item" }]`.
- Guardado: id aleatório, SHA-256 do recibo, versão do consentimento, dia UTC e os pares em ordem
  embaralhada. Sem usuário, IP, hash de IP, navegador ou hora.
- 201 `{ "ok": true }`; 400 `CONSENT_REQUIRED` (versão diferente da atual); 409 `DUPLICATE`
  (recibo já usado); 400 `INVALID_BODY`; 403 `TURNSTILE_FAILED`.

### `DELETE /api/v1/s6/batches/:receipt`

Público; o recibo é o segredo de quem enviou. Apaga o lote e seus pares. Sempre 204, existindo ou
não, já retirado ou mal formado: não serve de oráculo. Rajada por hash de IP, nada gravado.

### `GET /api/v1/s6/preferences`

O JSON "Comunidade prefere", gerado uma vez por dia pelo job de agregação. Público; cache de 60 s
com ETag; 404 antes da primeira execução.

```json
{
  "generatedAt": "2026-10-16T03:00:00.000Z",
  "consentVersion": "s6-consent-v1",
  "items": [{ "curveId": "…", "score": 1.234567, "comparisons": 42 }],
  "pairs": 1234,
  "converged": true
}
```

Bradley–Terry pela iteração MM de Zermelo; empate vale meia vitória para cada lado; normalização
pela média geométrica (média geométrica das pontuações = 1); parada com variação relativa máxima
abaixo de 1e-9 ou 10 000 iterações. A agregação lê a janela de 90 dias, até 200 000 pares, mais
novos primeiro, e confere de novo a elegibilidade dos dois itens. Há também limites de trabalho
(100 000 000 visitas) e tempo (10 s); `converged: false` indica que um limite de iterações,
trabalho ou tempo interrompeu a convergência e a pontuação é a melhor estimativa até ali.
`pairs` conta os pares elegíveis fornecidos ao estimador. Só a maior componente fortemente conexa
do grafo de comparações recebe pontuação (sem ela o estimador não existe). Pontuações com 6 casas
decimais; ordem por pontuação e depois por `curveId`.

## S7: troca às cegas

`TradeDto`: `{ id, status, lineageId, versionId, score, createdAt, matchedAt, scoredAt, expiresAt,
partner }`, com `status` ∈ `waiting` | `matched` | `revealed` | `expired` | `cancelled` e `score` =
a nota que você deu. `partner`:

- `null` enquanto espera, depois de expirar ou cancelar, ou quando o parceiro deixa de ser elegível;
- às cegas (`matched`): `{ "revealed": false, "curveId", "s1" }`, só o necessário para ouvir;
- revelado: `{ "revealed": true, "curveId", "s1", "score", "nickname", "username", "lineage" }`,
  com `score` = a nota que o parceiro deu à sua curva; `nickname` é o apelido de exibição e
  `username` é o apelido canônico para o link `/u/` (ambos `null` sem apelido ou com parceiro
  banido). `lineage` é `{ id, versionId, name }` só quando a linhagem do parceiro abre por id,
  senão `null`.

O id de usuário e o id da troca do parceiro nunca aparecem.
Em toda leitura, a elegibilidade do parceiro é conferida novamente. Se a linhagem for retirada,
ocultada, deixar de qualificar pela visibilidade ou reprovar no gate, a curva não é servida:
`partner` vem `null`; um par `matched` passa a `cancelled`, mas uma troca `revealed` mantém o estado.
Pareceres desatualizados da versão e do head são reavaliados na entrada e antes do pareamento ou
de servir o parceiro. A leitura de trocas reavalia no máximo 4 curvas desatualizadas; um parceiro
que ainda depende de parecer desatualizado fica `null` só nessa leitura, sem cancelamento por esse
motivo. O job de pareamento usa os pareceres armazenados, mas a leitura continua com essa proteção.

### `POST /api/v1/trades`

Verificado; corpo até 1 KiB: `{ "lineageId": "…", "versionId"?: "…" }` (padrão: o head). A
linhagem precisa ser própria, ativa e sem ocultação de moderação, ou pública e listável; a curva
da versão precisa passar no gate. A listabilidade de linhagem alheia exige também o head aprovado.
Uma linhagem própria pode ser privada ou não listada e ainda participar da troca. Pareia na hora
com a troca em espera mais antiga elegível; senão fica em `waiting`.

201 `{ "trade": TradeDto }`; 400 `INVALID_BODY`; 404; 422 `GATE_REJECTED`; 409 `ALREADY_ACTIVE`
(já existe uma troca `waiting` ou `matched` do usuário).

### `GET /api/v1/trades/me?cursor=&limit=`

Verificado. 200 `{ items: TradeDto[], nextCursor }`, mais nova primeiro, `private, no-store`;
400 `INVALID_CURSOR`.

### `POST /api/v1/trades/:id/score`

Verificado; corpo até 256 B: `{ "score": 1..5 }` (inteiro), uma vez. A segunda nota do par revela
as duas trocas no mesmo lote do banco. 200 `{ "revealed": boolean, "trade": TradeDto }`; 400
`INVALID_BODY`; 404 (não é sua); 409 `DUPLICATE` (já deu nota); 409 `CONFLICT` (não está pareada:
esperando, expirada, cancelada ou já revelada).

### `DELETE /api/v1/trades/:id`

Verificado; cancela a própria troca enquanto espera. 200 `{ "cancelled": true }`; 404; 409
`CONFLICT` depois de pareada ou encerrada.

Expiração: 72 h depois de entrar na fila ou depois do pareamento. Um job de hora em hora expira as
vencidas e tenta parear de novo as que ficaram esperando.

## Fora de `/api/v1`

### `GET /og/<versionId>.png`

Imagem OG de 1200 × 630 de uma versão. O cartão contém nome da versão, licença, gráfico e marca
do projeto, **sem autor ou apelido**. Público; só versões de linhagens que abrem por id (pública
ou não listada, ativa, sem moderação, dono não banido, head e curva da versão aprovados no gate).
Pareceres desatualizados são reavaliados antes da leitura, mesmo com PNG no R2; o servidor
confere a visibilidade antes de servir ou responder 304. Qualquer versão ilegível (privada
inclusive): 404 `text/plain` com `no-store`.

200 `image/png` com `cache-control: public, max-age=86400`, sem `immutable`, e `ETag` forte;
`If-None-Match` igual dá 304. Cópias já guardadas no navegador ou CDN podem durar até um dia após
uma mudança de visibilidade. Objetos do R2 com layout antigo, inclusive os que continham autor,
são tratados como falta de cache e substituídos. Só as faltas de cache renderizam, e essas passam
pelo rate limit do grupo `og` (`RL_API`, por usuário ou hash de IP).

### `GET /c/<id>?s=<shareId>`

Página da curva compartilhada, renderizada no servidor para as tags OG. `<id>` é o id da linhagem;
a visibilidade é a da sessão: desconhecida, privada de outra pessoa ou moderada responde 404;
retirada responde 410. Reavalia pareceres desatualizados do head e da versão selecionada; um head
que o gate atual reprova não abre para terceiros. Com `?s=` de um compartilhamento desta linhagem,
mostra a versão indicada se ainda for legível, senão o head. Para esse compartilhamento, a contagem
anônima diária de aberturas sobe depois da resposta, pela mesma função e regra de rate limit de
`POST /api/v1/shares/:id/open`; uma falha nessa contagem nunca derruba a página.
