# Capacidade e carga

Relatório da T5.6: como medimos o desempenho do open-auri em staging, quais são as metas e quanto
o plano Workers Paid comporta. Os números medidos ficam na seção "Resultados", preenchida pelo
orquestrador depois da execução em staging.

## Método

- **Ferramenta:** `autocannon` 8 (MIT), pela API programática, no script
  `web/tests/load/run.mjs`. Os cenários e a avaliação das metas ficam em
  `web/tests/load/scenarios.mjs`, com testes sem rede em `web/tests/load/run.test.mjs`.
- **Ambiente:** só staging (`https://<nome>-staging.<subdomínio>.workers.dev`) ou um servidor
  local. O script recusa `open-auri.com`, os subdomínios dele, o `workers.dev` de produção (que
  redireciona para o domínio de produção) e qualquer outra origem.
- **Cenários:**

  | Cenário      | Requisição                                      | Tipo                          | Meta p95 |
  | ------------ | ----------------------------------------------- | ----------------------------- | -------- |
  | `feed`       | `GET /api/v1/feed`                              | leitura cacheada (60 s, ETag) | < 300 ms |
  | `curve-page` | `GET /c/<id>` (`--curve` ou a primeira do feed) | página SSR da curva           | < 300 ms |
  | `rankings`   | `GET /api/v1/rankings`                          | leitura cacheada (60 s, ETag) | < 300 ms |
  | `publish`    | `POST /api/v1/curves` com envelope já aprovado  | escrita, gate cacheado        | < 1,5 s  |

- **Medida:** o script registra a latência de cada resposta e calcula p50, p95 e p99 só sobre as
  respostas 2xx. Respostas 429, 404 ou 3xx são rápidas e deixariam uma execução quebrada com cara
  de boa; elas entram na contagem de falhas, não nas latências.
- **Veredito por cenário (PASS ou FAIL):** p95 abaixo da meta, no mínimo 50 respostas 2xx nas
  leituras e 5 na publicação, e no máximo 5% de falhas (non-2xx, erros de conexão e timeouts). O
  resumo aponta à parte respostas 429/503 e redirecionamentos.
- **IP de origem:** o script não falsifica `cf-connecting-ip` nem `x-forwarded-for`. Em staging a
  borda da Cloudflare define o IP real, e os rate limits por IP valem para a máquina que roda a
  carga. Por isso as conexões ficam modestas (padrão 20; publicação no máximo 2).
- **Saída:** um JSON no stdout com, por cenário, `latencyMs` (p50, p95, p99, max), `requests`
  (total, 2xx, non-2xx, erros, timeouts e contagem por status), `throughput` (req/s e 2xx/s),
  `status` e `reasons`, além de `pass` geral. Código de saída: 0 tudo passou, 1 algum cenário
  falhou, 2 uso inválido ou origem recusada. Cenários sem pré-requisito no modo `all` (por exemplo
  `publish` sem cookie) saem como `SKIPPED` e não reprovam a execução.

## Metas

- Leituras cacheadas (`feed`, `rankings`, `/c/<id>`): **p95 < 300 ms**.
- Publicação com gate cacheado (`POST /api/v1/curves`): **p95 < 1,5 s**.

## Fatores que distorcem a medida em staging

- **Rate limit por IP:** `RL_API` permite 120 requisições por 60 s por grupo e por chave (usuário
  ou hash do IP), e `RL_WRITE` 30 por 60 s (`web/wrangler.template.jsonc`). Uma carga de 20 conexões
  de uma só máquina passa disso em segundos e recebe 429, o que reprova o cenário pela regra dos 5%.
  Antes da execução, o orquestrador escolhe uma destas saídas e registra a escolha nos resultados:
  1. subir temporariamente os limites de `RL_API` só no `env.staging`, fazer o deploy de staging,
     rodar a carga e voltar ao valor original com novo deploy;
  2. rodar com `--rate` abaixo do limite, o que mede latência mas não capacidade.
- **Cache de borda em `workers.dev`:** a documentação da Cache API indica que ela não tem efeito em
  subdomínios `workers.dev` (conferir na fonte abaixo). Se for o caso, as leituras em staging medem
  o caminho sem cache de borda, um limite superior conservador para produção em domínio próprio.
- **Cotas de publicação:** 30 publicações por dia UTC e 60 tentativas de gate em 24 h por usuário
  (`docs/api.md`). O cenário `publish` faz um número fixo de requisições (`--amount`, padrão 20,
  máximo 30) em vez de rodar por tempo. Uma conta que já publicou no dia recebe 429
  `QUOTA_EXCEEDED`.
- **Turnstile:** segundo `docs/api.md`, `POST /api/v1/curves` não exige Turnstile. O script envia
  mesmo assim o token de teste `XXXX.DUMMY.TOKEN.XXXX` em `x-turnstile-token` (ou o valor de
  `LOAD_TURNSTILE_TOKEN`), que só é aceito quando o ambiente usa a chave secreta de teste.

## Como rodar

Pré-requisitos (orquestrador):

1. Instalar a dependência de desenvolvimento no workspace web: `npm i -D autocannon@^8.0.0` em
   `D:\git\open-auri\web`.
2. Rodar os testes sem rede: `node --test tests/load/run.test.mjs` em `D:\git\open-auri\web`.
3. Para `publish`:
   - uma conta de teste de staging com e-mail verificado, sem publicações no dia;
   - um envelope S5 já aprovado no gate: no editor de staging, exportar a curva em
     "JSON open-auri/preset@1" e publicá-la uma vez pela interface, o que deixa o parecer do gate
     em cache para essa curva e versão do gate;
   - o cabeçalho `Cookie` da sessão dessa conta (cookies de sessão do better-auth, copiados das
     ferramentas do navegador) na variável de processo `LOAD_SESSION_COOKIE`. O valor nunca vai
     para arquivo, log ou relatório, e o script nunca o imprime.

Execução (pwsh, em `D:\git\open-auri\web`; troque os marcadores pelos valores reais só na sessão):

```powershell
# leituras, uma de cada vez para não somar rate limits
node tests/load/run.mjs --origin https://<nome>-staging.<subdomínio>.workers.dev --scenario feed
node tests/load/run.mjs --origin https://<nome>-staging.<subdomínio>.workers.dev --scenario rankings
node tests/load/run.mjs --origin https://<nome>-staging.<subdomínio>.workers.dev --scenario curve-page --curve <lineageId>

# publicação
$env:LOAD_SESSION_COOKIE = '<cabeçalho Cookie da sessão>'
node tests/load/run.mjs --origin https://<nome>-staging.<subdomínio>.workers.dev --scenario publish --envelope <caminho do JSON> --amount 20
Remove-Item Env:LOAD_SESSION_COOKIE

# tudo de uma vez (publish sai SKIPPED sem cookie ou sem --envelope)
node tests/load/run.mjs --origin https://<nome>-staging.<subdomínio>.workers.dev --scenario all --duration 20 --connections 20
```

Opções: `--duration` (1 a 300 s, padrão 20), `--connections` (1 a 100, padrão 20), `--rate`
(teto global de req/s), `--visibility` da publicação (`private` padrão, `unlisted` ou `public`).
Depois da execução, retirar as linhagens criadas pela carga (`POST /api/v1/lineages/:id/retract`
ou pela interface) se a visibilidade não for privada.

## Resultados

Execução em staging em 2026-10-17, de uma única máquina cliente no Brasil, com o rate limit de staging inalterado (120 leituras por 60 s por IP). Com 4 conexões sem limite de taxa, 90% das respostas do feed foram 429: o limite por IP funciona como projetado e impede medir capacidade a partir de um único IP. A medição de latência usou `--rate 1` (1 requisição por segundo, 30 s). O p50 de cerca de 210 ms é dominado pela ida e volta da rede entre o cliente e a borda. Curva compartilhada e publicação ficaram sem execução: o staging ainda não tem curva pública nem conta de teste (cadastro fechado até a ativação do domínio de e-mail, issue #32).

O veredito "FAIL" da ferramenta nas linhas com `--rate 1` vem do mínimo de 50 leituras bem-sucedidas por cenário, não da meta de latência, que foi cumprida.

| Cenário      | Conexões       | Duração ou quantidade | p50 (ms)      | p95 (ms)      | p99 (ms)      | req/s         | non-2xx       | Meta p95 | Resultado                     |
| ------------ | -------------- | --------------------- | ------------- | ------------- | ------------- | ------------- | ------------- | -------- | ----------------------------- |
| `feed`       | 1 (`--rate 1`) | 30 s                  | 213,8         | 271,9         | 452,6         | 1             | 0             | 300 ms   | meta de p95 cumprida          |
| `curve-page` | não executado  | não executado         | não executado | não executado | não executado | não executado | não executado | 300 ms   | sem curva pública em staging  |
| `rankings`   | 1 (`--rate 1`) | 30 s                  | 207,6         | 232,6         | 422,2         | 1             | 0             | 300 ms   | meta de p95 cumprida          |
| `publish`    | não executado  | não executado         | não executado | não executado | não executado | não executado | não executado | 1500 ms  | sem conta de teste em staging |

Registrar também: data, versão do Worker de staging, escolha sobre o rate limit (subida temporária
ou `--rate`), contagem de 429 por cenário e o tempo de CPU por requisição visto no painel de
métricas do Worker durante a janela da carga.

## Capacidade versus Workers Paid

Os valores abaixo são as referências do plano Workers Paid e dos produtos usados, conforme a
documentação da Cloudflare; o orquestrador confere cada um na fonte ao fechar o relatório, porque
preços e limites mudam.

| Recurso                  | Incluído no plano pago (referência)                     | Além do incluído (referência) | Fonte                 |
| ------------------------ | ------------------------------------------------------- | ----------------------------- | --------------------- |
| Requisições de Workers   | 10 milhões por mês                                      | US$ 0,30 por milhão           | [Workers pricing][wp] |
| CPU de Workers           | 30 milhões de CPU ms por mês                            | US$ 0,02 por milhão de CPU ms | [Workers pricing][wp] |
| CPU por invocação        | 30 s padrão, configurável até 5 min                     | não se aplica                 | [Workers limits][wl]  |
| Memória                  | 128 MB por isolate                                      | não se aplica                 | [Workers limits][wl]  |
| D1, linhas lidas         | 25 bilhões por mês                                      | US$ 0,001 por milhão          | [D1 pricing][d1p]     |
| D1, linhas escritas      | 50 milhões por mês                                      | US$ 1,00 por milhão           | [D1 pricing][d1p]     |
| D1, armazenamento        | 5 GB                                                    | US$ 0,75 por GB-mês           | [D1 pricing][d1p]     |
| D1, tamanho do banco     | 10 GB por banco; um banco processa uma consulta por vez | não se aplica                 | [D1 limits][d1l]      |
| KV, leituras             | 10 milhões por mês                                      | US$ 0,50 por milhão           | [KV pricing][kvp]     |
| KV, escritas e exclusões | 1 milhão por mês de cada                                | US$ 5,00 por milhão           | [KV pricing][kvp]     |
| KV, mesma chave          | 1 escrita por segundo por chave                         | não se aplica                 | [KV limits][kvl]      |
| R2, operações classe A   | 1 milhão por mês                                        | US$ 4,50 por milhão           | [R2 pricing][r2p]     |
| R2, operações classe B   | 10 milhões por mês                                      | US$ 0,36 por milhão           | [R2 pricing][r2p]     |
| R2, armazenamento        | 10 GB-mês; saída sem cobrança                           | US$ 0,015 por GB-mês          | [R2 pricing][r2p]     |
| Filas                    | 1 milhão de operações por mês                           | US$ 0,40 por milhão           | [Queues pricing][qp]  |

### Raciocínio

Com os números medidos, a capacidade mensal dentro do incluído é o menor destes quocientes:

- requisições: 10 milhões / requisições por visita;
- CPU: 30 milhões de CPU ms / (CPU ms médio por requisição × requisições por visita);
- D1: 25 bilhões de linhas lidas / linhas lidas por visita, e 50 milhões de linhas escritas /
  linhas escritas por ação de escrita;
- KV e R2: operações incluídas / operações por visita (o R2 recebe as imagens OG e o
  `access-log/`; o KV, o que as rotas gravarem nele).

Referências de escala, sem dados medidos ainda:

- 10 milhões de requisições por mês equivalem a cerca de 3,9 requisições por segundo em média
  (10.000.000 / 2.592.000 s). Picos acima disso não são problema de limite: o plano pago não tem
  teto diário de requisições, só cobrança além do incluído.
- 30 milhões de CPU ms divididos por 10 milhões de requisições dão 3 ms de CPU por requisição em
  média antes de qualquer cobrança extra. O tempo de CPU por rota sai do painel de métricas do
  Worker na janela da carga (não lido nesta execução; conferir no painel na próxima).
- O D1 executa as consultas de um banco em série. O teto de vazão de escrita e leitura ao vivo
  (`sort=new` do feed, publicação) é aproximadamente 1000 ms dividido pela duração média das
  consultas por requisição; as leituras cacheadas por 60 s não chegam ao D1 enquanto o cache vale.
- A publicação é limitada pela cota por usuário (30 por dia), não pela plataforma: mesmo com todos
  os usuários no teto, as linhas escritas ficam muito abaixo de 50 milhões por mês para a escala
  prevista.

Conclusão: nas leituras cacheadas a latência fica dentro da meta e o primeiro limite atingido é o rate limit por IP, de propósito. Pela plataforma, o recurso que se esgota primeiro na escala prevista é o tempo de CPU incluído, puxado pelo gate (cerca de 150 ms por curva nova), que fica limitado pelas cotas por usuário e pelo cache por `curve_id`. Repetir com várias origens de cliente e com a conta de teste depois da ativação do e-mail.

## Fontes

- Workers, preços: https://developers.cloudflare.com/workers/platform/pricing/
- Workers, limites: https://developers.cloudflare.com/workers/platform/limits/
- D1, preços: https://developers.cloudflare.com/d1/platform/pricing/
- D1, limites: https://developers.cloudflare.com/d1/platform/limits/
- KV, preços: https://developers.cloudflare.com/kv/platform/pricing/
- KV, limites: https://developers.cloudflare.com/kv/platform/limits/
- R2, preços: https://developers.cloudflare.com/r2/pricing/
- Filas, preços: https://developers.cloudflare.com/queues/platform/pricing/
- Cache API (comportamento em `workers.dev`):
  https://developers.cloudflare.com/workers/runtime-apis/cache/
- Rate limiting binding: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Turnstile, chaves e token de teste: https://developers.cloudflare.com/turnstile/troubleshooting/testing/
- autocannon (API programática): https://github.com/mcollina/autocannon

[wp]: https://developers.cloudflare.com/workers/platform/pricing/
[wl]: https://developers.cloudflare.com/workers/platform/limits/
[d1p]: https://developers.cloudflare.com/d1/platform/pricing/
[d1l]: https://developers.cloudflare.com/d1/platform/limits/
[kvp]: https://developers.cloudflare.com/kv/platform/pricing/
[kvl]: https://developers.cloudflare.com/kv/platform/limits/
[r2p]: https://developers.cloudflare.com/r2/pricing/
[qp]: https://developers.cloudflare.com/queues/platform/pricing/
