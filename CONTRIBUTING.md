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

## Executar e testar o Android

O projeto nativo fica em `D:\git\open-auri\apps\android`; a interface continua sendo o site
remoto. Veja a arquitetura, os limites de validação e os scripts em
[`D:\git\open-auri\docs\android.md`](docs/android.md). No Windows, instale JDK 21 e Android SDK
com plataforma 36, Build-Tools 36.x e Platform-Tools. Configure `JAVA_HOME` e `ANDROID_HOME`
(ou `ANDROID_SDK_ROOT`) para as instalações locais, sem versionar caminhos pessoais.

Execute na raiz `D:\git\open-auri`, com Node 24 (mínimo 22.12) e npm:

```pwsh
Set-Location D:\git\open-auri
npm ci
npm run doctor:android
npm run build:android
npm run test:android
npm run lint:android
npm run typecheck:android
```

- `build:android` gera o debug que abre produção; instale-o pelo Android Studio ou ADB. Para o
  site local no emulador, use `npm run build:android:e2e`, que fixa `http://10.0.2.2:4173`.
- `test:android` executa unidade Kotlin, Robolectric e a verificação de cobertura Kover. Não
  precisa de cabo nem emulador. Para instrumentação, com emulador ou aparelho disponível, use
  `npm run test:android:device`; a camada instrumentada também é exercitada no CI da Fase 3.
- A integração web precisa de `npm run test:web:unit`. Para paridade dos 11 presets e do
  Neutro, o filtro é `npm run test:web:unit -- native-parity`.
- Para o e2e `android-bridge`, configure o ambiente web conforme o desenvolvimento local no
  README e instale o Chromium do Playwright (`npm exec -w web -- playwright install chromium`).
  Com `STAGING_ORIGIN` ausente, rode
  `npm run test:web:e2e -- android-bridge --project=desktop --project=mobile`.
  O Playwright sobe os servidores locais e faz o build; a fixture usa o `native-bridge.js` real
  do Capacitor, com o lado nativo falso, não um `window.Capacitor` substituto.
- Execute as camadas em série. Não rode unidade web em paralelo com integração web, build ou
  e2e. Não execute dois comandos Gradle ao mesmo tempo.

**Gradle somente pelos scripts npm da raiz**, que passam por
`D:\git\open-auri\tools\run-gradle.mjs`. Não chame o wrapper diretamente nem contorne guardas,
verificação de dependências ou testes. Agentes e CI não gravam em cabo físico: essa validação é
humana e segue o checklist normal.

### Atualizar a verificação de dependências Android

Siga [`D:\git\open-auri\docs\android-build-security.md`](docs/android-build-security.md).
Robolectric usa os JARs do SDK resolvidos e verificados pelo Gradle; não habilite seu downloader
Maven em tempo de teste para contornar uma falha. Ao atualizar uma dependência, o mantenedor
pode regenerar os SHA-256 com o opt-in explícito, pelo mesmo runner:

```pwsh
npm run test:android -- --maintainer-metadata --write-verification-metadata sha256
```

Revise o diff de `D:\git\open-auri\apps\android\android\gradle\verification-metadata.xml` e
confira os novos checksums contra uma fonte confiável do artefato, independente do download
que os gerou. Não aceite checksums só porque o comando terminou. Depois da revisão, rode
`npm run test:android` novamente **sem** o opt-in, além de lint e build da área. O opt-in não
autoriza outros argumentos inseguros nem desliga a verificação; não use exclusões de tarefas
ou redução do nível de verificação. Nunca versione keystores, senhas ou arquivos locais do SDK.

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
