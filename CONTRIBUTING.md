# Como contribuir com o open-auri

Obrigado pelo interesse. Este repositório é **público**: leia as regras de dados antes de qualquer
commit.

## Fluxo de trabalho

1. Abra uma issue (ou comente numa existente) descrevendo o problema ou a proposta. Mudanças no
   protocolo, no gate ou na escrita no cabo precisam de discussão antes do código.
2. Crie um branch a partir de `main`.
3. Faça a mudança com testes (veja "Testes" abaixo) e rode a bateria localmente.
4. Abra o PR com a descrição do que mudou, por quê e como foi verificado. A CI roda lint, tipos,
   testes, build, e2e, auditoria de dependências e varredura de segredos; o PR só entra verde.

## Commits

- **Conventional Commits** com o id da tarefa ou da issue no fim, entre colchetes:
  `tipo(escopo): resumo no imperativo [ID]`. Exemplos:
  - `feat(web): aviso de loudness no checklist do cabo [T2.7]`
  - `fix(api): recusa cursor adulterado no feed [#27]`
  - `docs(operacao): runbook de rotação de segredos [T5.5]`
- Tipos usuais: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `ci`, `build`.
- Um assunto por commit. O corpo explica o porquê quando não for óbvio.
- **Nunca** acrescente trailers `Co-Authored-By` nem linhas "Generated with" (ou equivalentes) em
  commits, PRs ou arquivos.

## Testes

Toda mudança de comportamento vem com teste; correção de bug vem com o teste que falhava antes.

| Onde mudou | O que rodar |
|---|---|
| Núcleo (`src/`) | `npm test` e `npm run test:coverage` (mínimo de 95% de linhas, branches e funções) |
| Ferramentas (`tools/*.mjs`) | `npm run test:tools` (funções puras testáveis e CLI fino) |
| App web | `npm run test:web:unit`, `npm run test:web:int` e, para fluxos de página, `npm run test:web:e2e` |
| Worker de jobs | `npm run -w workers/jobs test` e `npm run -w workers/jobs check` |
| Templates do wrangler | `npm test` na raiz (confere crons, limites e bindings) |
| Sempre | `npm run check:all`, `npm run format:check` e `npm run check:sensitive` |

Regras de código: sem `as any`, `@ts-ignore`, `@ts-expect-error` ou `catch` vazio. Texto do usuário
só por interpolação do Svelte (`{texto}`); `{@html}` é proibido.

## i18n

- Idiomas: pt-BR (base) e en-US, com Paraglide JS. As mesmas chaves existem nos dois idiomas.
- **Mensagens por staging:** uma tarefa ou PR não edita `web/messages/pt-BR.json` nem
  `web/messages/en-US.json` diretamente. As chaves novas vão para
  `web/messages/_staging/<ID>.pt-BR.json` e `web/messages/_staging/<ID>.en-US.json` (sem `$schema`),
  com o prefixo da feature ou da página, e são mescladas depois por quem integra.
- Números: vírgula decimal em pt-BR, ponto em en-US, sinal de menos real (−).

## Regras de texto

- **Sem travessão (U+2014) em texto pt-BR**, em mensagens, docs e e-mails. Use vírgula, dois-pontos,
  parênteses, hífen ou meia-risca (–).
- Sem fórmulas como "Honest note:" ou "Just X. Just Y.".
- Os textos fixos (aviso legal, EM BREVE, confirmação experimental, aviso de flash e de loudness)
  são copiados literalmente; não reescreva.
- **Marcas proibidas como branding:** Moog, Minimoog, EMI, Abbey Road, Beatles, Ampex, Gibson,
  Antares, Auto-Tune, SSL/Solid State Logic, Harman (exceto no rótulo oficial do preset "Harman IE
  2019"), JBL, Samsung, Dolby (inclusive o duplo D), Bell, AT&T, Exxon, Yamaha, Apogee, Neve, Waves
  e o logo da Kuba. Os nomes das pessoas homenageadas aparecem só em texto.
- Nada no texto pode contradizer a verdade do hardware: só escrita, sem leitura de volta, flash com
  vida útil desconhecida, e o gate é semelhança com os presets oficiais, não prova de segurança.

## Dados sensíveis (repositório público)

- Nenhum dado pessoal ou da empresa em arquivo versionado, teste, log, issue ou PR: nomes,
  e-mails, CNPJ, endereço, IDs de conta e de recursos, subdomínio do `workers.dev`, caminhos do
  perfil do usuário. O nome do domínio do produto é público e pode aparecer.
- Esses valores vivem só no `.env` (fora do git; modelo em `.env.example` com placeholders) e
  chegam ao build e ao deploy por variáveis de ambiente. Scripts leem o `.env` com
  `node --env-file` e nunca imprimem valores.
- Segredos só vão para os Workers por `node tools/sync-secrets.mjs`, nunca por arquivo.
- Antes de cada commit: `npm run check:sensitive` (o mesmo que `node tools/check-sensitive.mjs`)
  precisa sair 0. Ele procura os valores do `.env` e caminhos locais em todos os arquivos
  versionados.
- Encontrou um segredo ou dado pessoal no histórico? Não abra issue pública: siga
  [`docs/operacao/runbooks/incidente.md`](docs/operacao/runbooks/incidente.md) e avise pelo canal
  indicado em [`docs/seguranca.md`](docs/seguranca.md).

## Licença

Ao contribuir, você concorda que sua contribuição é licenciada sob a [AGPL-3.0](LICENSE).
