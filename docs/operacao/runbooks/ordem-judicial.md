# Runbook: ordem judicial (registros de acesso)

## Quando usar

Chegou uma ordem judicial que requisita registros de acesso a aplicação (Marco Civil da Internet,
art. 10 e art. 15, §3º) de um período. Também serve, com o mesmo cuidado, ao pedido do próprio
titular aos seus registros (LGPD, art. 18, II), depois da verificação de identidade
([`docs/lgpd.md`](../../lgpd.md), ponto em aberto 4).

Pedido de **preservação** por prazo maior (art. 15, §2º) não é exportação: veja "Preservação"
abaixo.

## O que existe

- Um registro por requisição dinâmica: IP, porta de origem quando disponível, data e hora com fuso,
  id da conta se logada, grupo de rota (sem query string) e status.
- Cifrados com AES-GCM (keyring `ACCESS_LOG_KEY`), agrupados por hora no R2 em `access-log/`,
  indexados no D1 em `access_log_objects`. Retenção de 6 meses (ciclo de vida de 180 dias).
- Nunca entram em backup nem no dump público. Sem ordem, não são lidos.

## Pré-condições

- A ordem foi conferida pelo controlador ou pelo jurídico: autoridade competente, período e
  identificação do alvo. Sem ordem válida, não exporte.
- O período pedido está dentro dos últimos 6 meses (o que passou disso já foi apagado).
- `.env` atual, com o `ACCESS_LOG_KEY` igual ao do Worker (inclui as chaves antigas do keyring).
- Login OAuth do wrangler na conta de `CLOUDFLARE_ACCOUNT_ID`.
- Uma pasta privada **fora do repositório** para o arquivo de saída.

## Procedimento

1. Converta o período da ordem para ISO 8601 com fuso explícito (`Z` ou `±hh:mm`). A janela é
   inclusiva nas duas pontas. Exemplo de forma: `2026-03-01T00:00:00-03:00`.
2. Rode a ferramenta (sem `--env` = produção):

   ```pwsh
   node tools/access-log-query.mjs `
     --case "<REFERENCIA_DO_PROCESSO>" `
     --from <INICIO_ISO_COM_FUSO> `
     --to <FIM_ISO_COM_FUSO> `
     --operator "<IDENTIFICADOR_DO_OPERADOR>" `
     --out "<PASTA_PRIVADA>\<arquivo>.ndjson"
   ```

   - `--case`: de 3 a 120 caracteres (letras, dígitos, espaço e `. _ / º ° ª # : ( ) -`).
   - `--operator`: de 2 a 80 caracteres (letras, dígitos, espaço e `. _ @ -`); vai para a auditoria.
     Prefira um rótulo de função a um nome pessoal.
   - `--out`: arquivo novo; a ferramenta **recusa sobrescrever** e cria com permissão restrita.
   - Para ensaio em staging: `--env staging` (usa o bucket de staging).

3. O que a ferramenta faz, nesta ordem: registra o pedido em `access_log_requests` e espelha em
   `audit_log` (ação `access_log.query`) **antes** de decifrar qualquer coisa; consulta o índice;
   baixa só os objetos da janela para uma pasta temporária; decifra em memória; filtra pela janela;
   grava o NDJSON; registra a quantidade exportada; apaga as cópias temporárias. O terminal mostra
   só o id do pedido, as contagens e o caminho do arquivo.
4. Anote o id do pedido impresso ("Recorded request <id> ...") no registro do caso.
5. Se a ordem pede só um usuário ou um IP, filtre o NDJSON localmente, na pasta privada, e entregue
   só o necessário. Não mande o arquivo por canal sem cifra.
6. Entregue pelo meio indicado na ordem e apague as cópias locais depois da confirmação de
   recebimento, salvo exigência de guarda.

## Preservação

Para guardar além de 6 meses a pedido de autoridade, copie os objetos cifrados da janela (sem
decifrar) para um local privado sob controle do controlador, com a referência do caso, antes que o
ciclo de vida os apague. Registre o pedido e mantenha as entradas correspondentes do keyring
enquanto a preservação durar ([`rotacao-de-segredos.md`](rotacao-de-segredos.md)).

## Erros comuns

| Mensagem                                                       | Causa e ação                                                                      |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `Usage: ...`                                                   | Flag faltando, repetida ou desconhecida.                                          |
| `--from/--to must be ISO 8601 date-times with an offset`       | Falta o fuso (`Z` ou `±hh:mm`).                                                   |
| `Invalid window: --from must be before --to`                   | Janela invertida ou vazia.                                                        |
| `Refusing to overwrite an existing --out file`                 | Escolha outro nome de arquivo.                                                    |
| `Wrangler is not logged in to CLOUDFLARE_ACCOUNT_ID`           | Rode `npx wrangler login` com a conta certa.                                      |
| `ACCESS_LOG_KEY is not a valid keyring`                        | O `.env` está com formato inválido; compare com o Worker.                         |
| `Could not decrypt an access-log object (key id or integrity)` | Falta no keyring uma chave antiga, ou o objeto foi adulterado. Pare e investigue. |

## Verificação

- `/admin/auditoria` mostra `access_log.query` com o id do pedido e a janela (sem a referência do
  caso).
- O número de registros exportados da saída bate com as linhas do arquivo.
- Nenhum arquivo foi criado dentro do repositório: `git status` limpo.

## Rollback

Não há rollback: o pedido e a auditoria são só por acréscimo, de propósito. Se a exportação foi
feita por engano, apague o arquivo de saída, anote o motivo no registro do caso e informe o
controlador.
