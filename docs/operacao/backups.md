# Backups, dump público e limpeza (T5.3)

Fonte: plano T5.3, `docs\lgpd.md` (operações 12, 13, 19, 22, 23 e 25, medida M7). Código: `workers\jobs\src\jobs\backup.ts`, `public-dump.ts`, `cleanup.ts`, migração `web\migrations\0011_audit_retention.sql` e a ferramenta `tools\restore-backup.mjs`. Nenhum ID de recurso aparece aqui: nomes de banco, bucket e conta ficam só no `.env`.

## 1. Backup semanal do D1

### O que entra

Todas as tabelas da aplicação no D1, lidas em páginas por chave (rowid ou chave primária nas tabelas `WITHOUT ROWID`): contas e sessões do Better Auth, perfil, curvas, linhagens, versões, favoritos, atividade, compartilhamentos, packs, denúncias, S6, S7, rankings, supressões de e-mail, aceites da política, reservas de apelido e o registro de auditoria. Inclui dados de conta (operação 22 do registro).

### O que não entra

| Tabela ou dado                                                       | Motivo                                                                                                            |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Registros de acesso (prefixo `access-log/` do R2)                    | Ficam só no R2, cifrados, com ciclo de vida de 180 dias (operação 25). Nenhum backup os copia                     |
| Tabelas `access_log_*` (`access_log_objects`, `access_log_requests`) | Regra da T5.3: nada dos registros de acesso entra no backup. Veja a seção 7 sobre o efeito disso numa restauração |
| `rate_limit_counters`                                                | Contadores de janela curta, recriados sozinhos                                                                    |
| `d1_migrations`                                                      | Recriada ao aplicar as migrações; o nome da última migração vai no manifesto como versão do esquema               |
| `_cf_*` e `sqlite_*`                                                 | Tabelas internas do D1 e do SQLite                                                                                |

### Formato e local

No bucket R2 do binding `MEDIA`, prefixo `backups/<ANO>-W<semana ISO>/`:

- `<tabela>.ndjson.gz`: uma linha JSON por registro, gzip. Tabela grande demais para uma execução continua em `<tabela>.2.ndjson.gz`, `<tabela>.3.ndjson.gz` e assim por diante;
- `manifest.json`: escrito por último, só quando todas as tabelas terminaram. Traz a semana, início e fim, a versão do esquema, a lista de exclusões, cada tabela com o seu `CREATE TABLE`, número de linhas e arquivos (linhas, bytes e SHA-256 do arquivo gzip) e os gatilhos (`CREATE TRIGGER`).

Uma semana sem `manifest.json` está incompleta e não serve para restauração.

### Execução limitada e retomada

Cada execução lê no máximo 400 páginas de 500 linhas e para depois de 25 s; um arquivo é fechado a cada 8 MiB de NDJSON. O progresso (semana, tabelas, cursor por tabela, arquivos já escritos) fica no KV `CONFIG`, chave `job:backup:state`, gravado uma vez no fim da execução. Uma execução interrompida refaz as suas páginas na próxima e sobrescreve as mesmas chaves. Depois do manifesto, toda execução da mesma semana é uma leitura de KV e nada mais (idempotente por semana).

A semana do backup é a semana ISO deslocada de 3 horas (`backupWeek`): entre 00:00 e 02:59 UTC de segunda o job só retoma ou pula a semana anterior, e o backup novo começa na execução de hora em hora das 03:00.

O backup não é um instantâneo de um único momento: as tabelas são lidas ao longo de minutos ou horas. Para voltar a um instante exato, use o Time Travel (seção 6).

### Retenção

Ao concluir uma semana, o job apaga todo `backups/<semana>/` mais antigo que 12 semanas. Ficam a semana corrente e as 12 anteriores, ou seja, pelo menos 12 backups completos. Dados apagados depois de um backup (exclusões, encerramento de conta, retirada de consentimento) permanecem nesses arquivos, sem uso, até a semana sair da retenção (operação 22).

O bucket continua privado: não pode ter acesso público (domínio `r2.dev` ou domínio customizado) em nenhum prefixo. Somente o operador lê `backups/`, pelo Wrangler. O único conteúdo do bucket exposto ao público é o dump (seção 2), e só pela rota da aplicação.

## 2. Dump público semanal

Arquivos `public/dump/<AAAA-MM-DD>.json.gz` (dia UTC da execução) e `public/dump/latest.json.gz`, JSON em gzip (operação 23).

Contém: linhagens publicamente listáveis (mesma regra das listas do site: pública, ativa, visível, cabeça aprovada no gate e dono não banido), as versões cuja curva passa no gate atual (S1, nome, descrição, licença, idioma, versão mãe, data), contagens públicas de favoritos e instalações (só contas verificadas e não banidas, como no site), rankings materializados restritos a essas linhagens, os links das licenças e um campo `readme` (pt-BR e en-US) que explica CC0 e CC-BY.

O apelido do autor aparece só nas versões CC-BY-4.0, porque a licença exige atribuição. Após encerramento de conta com anonimização, o crédito é `autor removido`. Uma bifurcação aponta para a origem só quando a versão de origem também está no dump.

Nunca entram: e-mail, IDs de usuário, atividade nominal (quem favoritou ou instalou), hashes, IP, receitas, conteúdo privado, não listado, retirado ou oculto, dados de moderação. Uma nova execução no mesmo dia sobrescreve os dois arquivos. Novos dumps refletem exclusões e anonimizações; cópias já baixadas por terceiros permanecem, como diz a política.

O público baixa esses arquivos só pela rota da aplicação `GET /dados/dump/latest.json.gz` e pelas edições datadas `GET /dados/dump/<AAAA-MM-DD>.json.gz`, que leem o prefixo `public/dump/` pelo binding `MEDIA`. O bucket não tem acesso público; nenhum outro prefixo é alcançável por essa rota.

## 3. Limpeza diária

`cleanup.ts` apaga só o que passou da retenção do `docs\lgpd.md`:

| Passo              | Tabela                                             | Apaga quando                                                                                               |
| ------------------ | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `sessions`         | `session`                                          | `expiresAt` já passou (operação 3)                                                                         |
| `verifications`    | `verification`                                     | `expiresAt` já passou (tokens, operação 2)                                                                 |
| `link-uses`        | `auth_link_uses`                                   | `expires_at` já passou                                                                                     |
| `email-changes`    | `email_change_requests`                            | `expires_at` já passou                                                                                     |
| `access-log-index` | `access_log_objects`                               | dia com mais de 180 dias (índice; os objetos no R2 já têm o ciclo de vida e o job `access-log-retention`)  |
| `suppressions`     | `email_suppressions`                               | criada há mais de 12 meses (operação 19)                                                                   |
| `audit`            | `audit_log`                                        | criada há mais de 5 anos e 1 dia (operação 12)                                                             |
| `s6`               | `s6_batches` e `s6_pairs`                          | dia do lote com mais de 24 meses (operação 13)                                                             |
| `username-holds`   | `username_holds`                                   | `released_at` já passou (reserva de 90 dias, operação 4)                                                   |
| `tombstones`       | `lineages` (e trocas e denúncias dessas linhagens) | lápide (`status = 'retracted'`) sem alteração há 365 dias e sem nenhuma bifurcação de qualquer versão dela |

Decisões:

- **Auditoria:** a migração 0003 bloqueava qualquer `DELETE` em `audit_log`. A migração `0011_audit_retention.sql` troca esse gatilho por um que continua recusando apagar linhas com menos de 5 anos (relógio do banco). Atualizações continuam proibidas. O job usa um corte um dia mais antigo, então nunca esbarra no gatilho.
- **Lápides:** 365 dias dão um ano para o dono desfazer a retirada. Lápides com bifurcações ficam, para que as derivadas continuem mostrando a origem. Versões, favoritos, atividade, compartilhamentos, itens de pack e rankings saem junto por `ON DELETE CASCADE`; a imagem OG sai no próximo `og-sweep`.
- **S6:** o agregado publicado é recalculado todo dia a partir dos pares que restam, portanto passa a refletir os últimos 24 meses.
- **`access_log_requests`:** não é tocada (retenção de 5 anos, só inclusão, gatilho próprio da 0007).

Limites por execução: até 500 linhas por comando (90 lotes do S6 e 50 lápides por comando), até 10 comandos por passo e 20 s no total. O que sobra sai no dia seguinte. O log tem só contagens por passo.

## 4. Agendamento

Registrados na T5.7 em `workers\jobs\src\jobs\registry.ts` (ordem dentro de cada cron = ordem de execução):

| Job          | Export          | Cron (UTC)                                                                                                                                                                                                                              |
| ------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backup       | `backupJob`     | Só no cron de hora em hora `0 * * * *` (depois do re-gate e da expiração de trocas). A semana do backup começa segunda às 03:00 UTC: essa execução inicia o backup novo e as seguintes continuam até o manifesto; depois de completo, cada execução é uma leitura de KV |
| Dump público | `publicDumpJob` | `0 3 * * 1` (segunda, 03:00; único job desse cron)                                                                                                                                                                                                          |
| Limpeza      | `cleanupJob`    | `5 0 * * *` (cron diário, depois dos outros jobs diários)                                                                                                                                                                               |

Um cron novo exige a lista `triggers.crons` do `workers\jobs\wrangler.template.jsonc` (nos três ambientes) e `CRONS` no `registry.ts`.

## 5. Antes de qualquer operação de risco

Anote um bookmark do Time Travel antes de migrações, limpezas manuais ou restaurações:

```
npx wrangler d1 time-travel info <BANCO> --env production
```

Guarde o bookmark impresso fora do repositório.

## 6. Runbook de restauração

1. **Ligue o modo somente leitura** (`docs\operacao\runbooks\somente-leitura.md`) e registre o incidente (`runbooks\incidente.md`).
2. **Primeira opção: Time Travel.** Se o ponto desejado está dentro da janela do Time Travel do D1 (30 dias no plano pago), restaure por bookmark ou horário:

   ```
   npx wrangler d1 time-travel info <BANCO> --timestamp <AAAA-MM-DDTHH:MM:SSZ> --env production
   npx wrangler d1 time-travel restore <BANCO> --bookmark <BOOKMARK> --env production
   ```

   A restauração sobrescreve o banco inteiro, inclusive `access_log_*` e contadores, e imprime um bookmark de desfazer: guarde-o.

3. **Segunda opção: backup do R2** (fora da janela do Time Travel, ou banco perdido):
   1. Escolha a semana em `backups/` cujo `manifest.json` existe. Baixe o manifesto para um diretório temporário fora do repositório:

      ```
      npx wrangler r2 object get "<BUCKET>/backups/<SEMANA>/manifest.json" --file "<DIR>\manifest.json" --remote
      ```

   2. Gere e execute os comandos de download dos arquivos:

      ```
      node tools/restore-backup.mjs <DIR> --print-downloads <BUCKET>
      ```

   3. Crie um banco D1 novo e vazio (`npx wrangler d1 create <NOVO_BANCO>`) e aplique as migrações até a versão `schemaVersion` do manifesto (`npx wrangler d1 migrations apply <NOVO_BANCO> --remote`, a partir de `web\`, num checkout cuja última migração seja essa; migrações mais novas são aplicadas depois da importação).
   4. Gere o SQL. A ferramenta confere tamanho, SHA-256 e número de linhas de cada arquivo e aborta em qualquer divergência:

      ```
      node tools/restore-backup.mjs <DIR> --out <DIR>\restore.sql
      ```

      O SQL liga `PRAGMA defer_foreign_keys`, remove os gatilhos do manifesto, insere as linhas tabela por tabela e recria os gatilhos. Nunca rode esse SQL contra um banco com dados.

   5. Importe: `npx wrangler d1 execute <NOVO_BANCO> --remote --file <DIR>\restore.sql`.
   6. Confira as contagens (`SELECT COUNT(*)`) de algumas tabelas contra `rows` do manifesto.
   7. Aponte `D1_DATABASE_ID` e `D1_DATABASE_NAME` do `.env` para o banco novo, rode `node tools/render-wrangler.mjs` e faça o deploy dos dois Workers (web e jobs).
   8. Apague `<DIR>` (contém dados pessoais) e guarde o banco antigo até confirmar o resultado.
4. **Reaplique as exclusões** feitas desde o ponto restaurado (encerramentos de conta, exclusões de conteúdo, retiradas do S6, pedidos de titulares), usando o registro de auditoria, a caixa do canal do titular e `runbooks\exclusao-lgpd-manual.md`. O registro LGPD (operação 22) promete isso.
5. Desligue o modo somente leitura e anote no incidente o bookmark ou a semana usada.

### O que uma restauração pelo R2 não traz de volta

- `access_log_objects`: índice dos objetos de registros de acesso. Os objetos continuam no R2 (`access-log/AAAA/MM/DD/`), mas a ferramenta de ordem judicial depende do índice. Até reconstruí-lo, pedidos judiciais da janela afetada precisam de listagem manual do R2. Use o Time Travel sempre que possível.
- `access_log_requests`: o histórico de pedidos judiciais. Cada consulta também gera linha em `audit_log`, que está no backup.
- Contadores de rate limit (recomeçam do zero, sem impacto).

## 7. Verificação em staging

1. Rode os jobs contra os recursos de staging com o Wrangler local e bindings remotos:

   ```
   npx wrangler dev --env staging --remote --test-scheduled
   ```

   e, em outro terminal, dispare `http://localhost:8787/__scheduled?cron=0+*+*+*+*` para o backup (repita até `job.backup` mostrar `complete` ou `skipped`), `http://localhost:8787/__scheduled?cron=0+3+*+*+1` para o dump e `http://localhost:8787/__scheduled?cron=5+0+*+*+*` (limpeza e os outros jobs diários).

2. Confirme no R2 de staging: `backups/<semana>/manifest.json`, nenhum arquivo `access_log*` ou `rate_limit*` na semana, `public/dump/latest.json.gz`.
3. Siga a seção 6, passo 3, com um banco descartável (`<NOVO_BANCO>` só para o teste), confira as contagens e apague o banco descartável e o diretório local.
4. Teste o Time Travel em staging: anote um bookmark, faça uma alteração inofensiva, restaure pelo bookmark e confira.
5. Registre a data do teste no incidente ou no relatório da fase (medida M7: restauração testada em staging).
