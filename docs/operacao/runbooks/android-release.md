# Runbook: release Android, assinatura e controle de gravação

## Quando usar

- Preparar H-KEY/H-ENV e publicar APK no GitHub e AAB para upload manual à Play.
- Rotacionar credenciais, responder à perda/comprometimento de chave ou retirar uma release.
- Desligar/restringir gravação pelo app, encerrar ou reabrir o aviso de hardware não validado.
- Operar merge e deploy autônomos conforme o plano Android, seção 0.21.

Referências: [plano Android](../../plans/2026-10-18-android-capacitor-plano.md) (0.12, 0.15, 0.19, 0.21, 4.6, F5), [deploy e rollback](../../deploy.md), [modelo de ameaças](../../seguranca.md), [Data safety](../../android/data-safety.md). Este runbook não autoriza agentes a gravar em cabo físico, gerar chaves reais ou aprovar Environments em nome do mantenedor.

## Pré-condições

1. Mantenedor com acesso administrativo ao GitHub, à Play e ao registro do pacote `com.openauri.app`; ambiente offline confiável com JDK 21/keytool, mídia de backup cifrada e gerenciador de senhas. Nunca levar keystores, PEPK, senhas, base64 ou credenciais ao chat, ao repositório, a logs ou a artifacts.
2. Duas chaves distintas: **app** para o APK do GitHub e para Play App Signing; **upload** só para o AAB enviado à Play. Não aceitar a geração de uma chave diferente pela Play sem rever a decisão de mesma assinatura entre fontes. A chave de upload não é a identidade instalada do app.
3. Commit exato revisado; testes direcionados e gates da fase verdes, QA PASS sem FX aberto, CI verde no HEAD do PR e `npm run check:sensitive` verde antes do merge. Documentar hash do commit e URLs das execuções. Para publicar, conferir também os checks do commit que receberá a tag.
4. Pendências humanas de publicação (P6/P7) resolvidas. O passo a passo de Console/PEPK será registrado em `docs/android/play-assinatura.md` pela P6; se esse documento ainda não existir ou H-KEY/H-ENV não estiver confirmado, não publicar. Validar a declaração Data safety e as pendências de fornecedores antes de assiná-la no Console.
5. Não confundir estado do código com configuração já aplicada na conta GitHub: o operador deve conferir Environment, revisores e ruleset no painel. Ter apenas `environment: android-release` no YAML não cria essas proteções.
6. Conferir se a label **`android-cable-report`** existe no repositório antes de divulgar o formulário `.github/ISSUE_TEMPLATE/android-cable-report.yml`. O GitHub descarta labels desconhecidas nos issue forms; o YAML não as cria. Se faltar, o mantenedor deve criá-la na raiz do checkout com GitHub CLI autenticado e autorização para administrar labels:

   ```powershell
   gh label create android-cable-report --description "Relatos de gravação no cabo pelo app Android" --color 0E8A16
   ```

## Procedimento

### 1. Criar e custodiar as duas chaves (H-KEY, humano, offline)

Em diretório privado **fora do repositório**, numa máquina offline, rode separadamente. Os exemplos usam nomes e DN do projeto, não dados pessoais; escolha senhas fortes distintas para cada keystore nos prompts, sem colocá-las na linha de comando. Em PKCS12, mantenha a senha da entrada igual à senha do respectivo keystore para compatibilidade com keytool.

```powershell
keytool -genkeypair -keystore open-auri-app.p12 -storetype PKCS12 -alias open-auri-app -keyalg RSA -keysize 4096 -sigalg SHA256withRSA -validity 10000 -dname "CN=open-auri app, O=open-auri, C=BR"
keytool -genkeypair -keystore open-auri-upload.p12 -storetype PKCS12 -alias open-auri-upload -keyalg RSA -keysize 4096 -sigalg SHA256withRSA -validity 10000 -dname "CN=open-auri upload, O=open-auri, C=BR"
keytool '-J-Duser.language=en' -list -v -keystore open-auri-app.p12 -storetype PKCS12 -alias open-auri-app
keytool '-J-Duser.language=en' -list -v -keystore open-auri-upload.p12 -storetype PKCS12 -alias open-auri-upload
keytool -exportcert -rfc -keystore open-auri-upload.p12 -storetype PKCS12 -alias open-auri-upload -file open-auri-upload-cert.pem
```

- A validade de 10000 dias supera 25 anos. Anote validade, aliases e fingerprints **SHA-256 dos certificados**, com rótulos app/upload; devem ser diferentes. Não confundir com SHA-256 do arquivo `.p12` ou do APK.
- Faça backup cifrado das duas chaves em **dois locais físicos independentes**, com acesso restrito. Guarde senhas separadamente, com plano de recuperação. Teste a leitura de cada cópia e confira os fingerprints, sem publicar material privado. Registre quem tem custódia e a data do teste.
- Pela P6 e pelas instruções atuais do Play Console, use a ferramenta **PEPK oficial** e a chave pública de cifragem fornecida pela Play para exportar **a chave do app**, não a de upload, ao Play App Signing. Não improvisar parâmetros de cifragem: seguir `docs/android/play-assinatura.md` quando entregue. O arquivo PEPK cifrado também fica fora do repositório/artifacts. Cadastre o certificado da chave de upload para envio dos AABs.
- Antes da primeira release aberta/produção, confira no Console que o SHA-256 de **assinatura do app** coincide com o da chave offline e do APK GitHub. Registre pacote e certificado na verificação de desenvolvedor Android conforme P6. Pare se a Play mostrar outra chave; não anunciar atualização intercambiável entre fontes sem essa igualdade.

### 2. Proteger assinatura e tags (H-ENV, humano)

Em Settings > Environments, criar **`android-release`**:

1. Required reviewers: mantenedor responsável obrigatório, com prevenção de autoaprovação quando disponível; não permitir bypass administrativo. Se o plano da conta não suportar essas proteções, interromper a publicação em vez de liberar os secrets em nível de repositório.
2. Deployment branches and tags: **Selected branches and tags**, regra do tipo **Tag** `android-v*`; não criar regra de branch com esse nome, nem permitir todas as branches/tags.
3. Em Settings > Rules > Rulesets, criar ruleset ativo para **tags** `android-v*`, restringindo **criação, atualização e exclusão**. Autorizar somente o mantenedor/release manager necessário para criar a tag revisada, com exceções mínimas e auditadas; não dar bypass ao bot/orquestrador. Não mover nem reutilizar tag publicada. Conferir a proteção antes de subir chaves.
4. Adicionar os oito secrets abaixo **só no Environment**, nunca em secrets gerais de repositório/organização. A codificação base64 é transporte, não cifragem: fazê-la localmente por ferramenta confiável, transferir pelo painel seguro e remover cópias temporárias.

| Secret | Conteúdo |
|---|---|
| `ANDROID_APP_KEYSTORE_B64` | Base64 do PKCS12 da chave do app |
| `ANDROID_APP_KEYSTORE_PASSWORD` | Senha desse keystore |
| `ANDROID_APP_KEY_ALIAS` | Alias da chave do app |
| `ANDROID_APP_KEY_PASSWORD` | Senha da entrada do app (igual à do keystore PKCS12) |
| `ANDROID_UPLOAD_KEYSTORE_B64` | Base64 do PKCS12 da chave de upload |
| `ANDROID_UPLOAD_KEYSTORE_PASSWORD` | Senha desse keystore |
| `ANDROID_UPLOAD_KEY_ALIAS` | Alias da chave de upload |
| `ANDROID_UPLOAD_KEY_PASSWORD` | Senha da entrada de upload (igual à do respectivo keystore PKCS12) |

No Windows/PowerShell, na pasta privada dos keystores da etapa 1, envie o base64 puro direto ao secret com o GitHub CLI, sem arquivo intermediário nem área de transferência. Use caminho absoluto (`"$PWD\..."`): o .NET não segue o diretório atual do PowerShell.

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$PWD\open-auri-app.p12")) | gh secret set ANDROID_APP_KEYSTORE_B64 --env android-release --repo marco-jardim/open-auri
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$PWD\open-auri-upload.p12")) | gh secret set ANDROID_UPLOAD_KEYSTORE_B64 --env android-release --repo marco-jardim/open-auri
```

Sem o GitHub CLI, grave o base64 num arquivo privado, cole o conteúdo pelo painel seguro e apague o arquivo e o item do histórico da área de transferência. `certutil -encode` adiciona linhas de cabeçalho e rodapé; sua saída não é base64 puro e não deve ser copiada integralmente para esses secrets.

Configurar também os dois fingerprints públicos esperados no Environment:

| Variable ou secret | Conteúdo |
|---|---|
| `ANDROID_APP_CERT_SHA256` | SHA-256 do certificado do app, usado para verificar o APK; não usar o certificado de upload |
| `ANDROID_UPLOAD_CERT_SHA256` | SHA-256 do certificado de upload, usado para verificar o AAB; deve ser diferente do certificado do app |

Para cada nome, o workflow usa **variable do Environment ou secret**, exatamente `vars.ANDROID_APP_CERT_SHA256 || secrets.ANDROID_APP_CERT_SHA256` e `vars.ANDROID_UPLOAD_CERT_SHA256 || secrets.ANDROID_UPLOAD_CERT_SHA256`: a variable não vazia tem precedência; se estiver vazia/ausente, usa o secret. Escolher uma única fonte, ou manter ambas idênticas para não mascarar um secret corrigido com variable antiga. Ambos são obrigatórios no job de assinatura e aceitam **64 dígitos hexadecimais, com ou sem dois-pontos, em maiúsculas ou minúsculas**, conforme `tools/android-artifacts.mjs`.

Para obter o fingerprint de upload, rode `keytool -list -v -keystore open-auri-upload.p12 -storetype PKCS12 -alias open-auri-upload` em ambiente privado e copie o valor da linha **SHA256** do certificado. Substitua arquivo/alias pelos da chave de upload criada na etapa 1; se necessário, use `'-J-Duser.language=en'` (entre aspas simples no PowerShell, que senão quebra o argumento no ponto) para obter esse rótulo. Não usar o hash do arquivo do keystore. Após um **upload-key reset** confirmado pela Play, atualizar `ANDROID_UPLOAD_CERT_SHA256` com o certificado novo junto dos secrets de upload.

Nomes e isolamento conferíveis em `.github/workflows/android-release.yml`: `build` não recebe chaves; `sign-and-publish` usa o Environment e só roda no push de tag `android-v*`. O material decodificado é temporário e removido em `always()`. O nome temporário `.jks` não converte o PKCS12. O dispatch manual é **somente dry-run**, com duas chaves efêmeras e sem release, sem acesso às chaves protegidas. O revisor deve conferir commit, diff do workflow e scripts executados antes de liberar secrets: o Environment não torna código hostil seguro.

### 3. Publicar site e release

1. Publicar o fingerprint público **da chave do app** em `PUBLIC_ANDROID_CERT_SHA256` pelo fluxo de configuração/deploy do site, com `PUBLIC_ANDROID_APP_ID=com.openauri.app`. São valores públicos, não chaves privadas. `web/src/lib/server/android/app-links.ts` aceita fingerprints múltiplos separados por vírgula para transições legítimas. Conferir `/.well-known/assetlinks.json` após o deploy; fingerprint vazio/inválido desativa App Links. Não incluir o certificado de upload nessa lista.
2. Fazer merge/deploy do site pelo procedimento 0.21 abaixo, sem contornar a aprovação humana de produção. Mudanças na política exigem `POLICY_VERSION`, linhas de versão nas duas políticas, `PUBLIC_POLICY_EFFECTIVE_DATE` de publicação e testes coerentes; a versão 2026-10-20 inclui o canal Android e reapresenta o aviso de confirmação aos usuários com versão anterior.
3. Em Actions, executar `android-release.yml` por `workflow_dispatch` com `dry_run=true`, conferir verificação de configuração, assinatura com chaves efêmeras e artifacts de ensaio. Não distribuir esses artifacts aos usuários e não cadastrar seu fingerprint no site/Play.
4. Preparar versão em `apps/android/package.json` e tag exata `android-v<versão>`, por exemplo `android-v1.0.0`. O workflow exige correspondência e `versionCode` crescente, derivado de `major*10000 + minor*100 + patch` (minor/patch até 99). A checagem automática de histórico não substitui a comparação com o maior código já enviado à Play nem a conferência do histórico de releases retiradas; não depender apenas da listagem de releases atuais.
5. O mantenedor autorizado cria e envia a tag no commit aprovado, de acordo com o ruleset. Conferir o build sem assinatura e, na solicitação de aprovação de `android-release`, conferir tag/commit, resultados e proveniência do artifact. Só então aprovar humanamente a assinatura.
6. A release recebe `open-auri-<versão>.apk`, `.aab`, `SHA256SUMS.txt`, `release-manifest.json` e notas. APK: chave do app, esquemas v2/v3 e fingerprint esperado verificado. AAB: chave de upload distinta, verificação por jarsigner. Upload à Play é **manual**, seguindo P6/P7; o workflow não publica na Play.

### 4. Desligar ou restringir a gravação

Editar **`web/src/lib/cable/android-status.ts`**, revisar/testar e fazer **deploy do site**, staging antes de produção. Não é mudança de KV, recompilação do APK ou configuração da Play. Os controles não substituem o modo somente leitura do servidor e não afetam o WebHID desktop.

| Situação | Controle e efeito |
|---|---|
| Risco generalizado, incidente USB ou incerteza sobre quais versões são afetadas | `ANDROID_WRITE_POLICY.enabled = false`: app fica em modo simulado, com aviso, sem I/O USB de gravação pelo fluxo bloqueado |
| Bug restrito a releases conhecidas | Acrescentar a `blockedAppVersions` versões exatas, como `'1.0.0'`, ou limite estrito, como `'<1.0.3'`; versões afetadas pedem atualização e usam simulação. Não usar ranges npm/coringas. Entrada inválida bloqueia todas; versão de app inválida também é recusada |
| Correção comprovada e pronta para liberar | Manter bloqueadas as versões vulneráveis; reativar `enabled` só após testes/QA, staging e smoke. Não apagar bloqueios só porque saiu uma release nova |

#### Encerrar o aviso

Somente após a validação **humana** da F5: paridade no fio e resultados nos celulares exigidos, Q5/QGH e evidências arquivadas. Alterar `ANDROID_WRITE_VALIDATED = true` e implantar o site. Isso retira aviso/banner e a exigência `android-untested` nos novos checklists nativos. Testes com dispositivos falsos ou emulador não autorizam essa troca. Não há nova release Android obrigatória apenas para retirar o aviso.

#### Reabrir o aviso

Se a validade física voltar a ser incerta ou o texto precisar de novo reconhecimento, definir `ANDROID_WRITE_VALIDATED = false` e incrementar **`ANDROID_DISCLAIMER_VERSION`**. Implantar o site: o modal reabre para quem aceitou a versão anterior, o banner volta e cada gravação nativa exige `android-untested`, inclusive resgate e fila. Só incrementar a versão não reabre aviso enquanto o estado estiver validado. Se houver risco concreto, desligar/bloquear gravação também; reconhecimento do usuário não é mitigação suficiente para um defeito conhecido.

#### Frescor da página e operação offline

`assertNativeWriteFresh` em `web/src/lib/cable/native-freshness.ts`, chamado por `service.ts` em `exclusive`, consulta **`/_app/version.json` antes de iniciar cada escrita/fila nativa**, com `cache: no-store`, cabeçalho `no-cache` e limite de 3 s, comparando com a versão do site carregada. Cada sucesso ao vivo guarda a última confirmação (`oa.cable.nativeLastGood.v1` no `localStorage`: versão do deploy e horário).

- Página aberta antes de um deploy recusa a próxima escrita/fila até **Recarregar**, carregando então a política nova, e apaga a última confirmação desse aparelho. Qualquer deploy de site pode disparar isso, não só o que muda `android-status.ts`.
- Offline, timeout, erro HTTP, JSON inválido ou resposta sem versão: a escrita/fila **segue de forma otimista, sem prazo**, só se a última confirmação guardada for da mesma versão da página; o resultado avisa a data dessa confirmação. Sem registro, com registro de outra versão ou malformado: **recusa**.
- O registro também é apagado ao iniciar uma página de outra versão, quando a detecção dá `native-write-disabled` e quando o Kit avisa deploy mais novo (`updated`, banner do app). O diário registra `freshness` (`live` ou `last-good`, com o horário da confirmação) em cada gravação nativa, para revisão de incidente.
- **Alcance dos controles remotos (risco residual):** `ANDROID_WRITE_POLICY` (desligar ou bloquear versões) só chega a um aparelho cuja checagem falha (offline, `/_app/version.json` bloqueado, erro do servidor ou timeout) quando ela volta a funcionar e ele carrega o deploy novo; até lá, ele pode gravar com a política da página que tem. Essa página pode ser o shell que o service worker serve offline, possivelmente mais antigo que a última página que o aparelho rodou; a limpeza acima limita o caso a páginas da mesma versão da última confirmação, num aparelho que não viu deploy mais novo. Não tratar o desligamento remoto como efeito imediato nesses aparelhos.
- A fila tem **uma checagem no início**, não a cada cabo nem report (`service.ts`, `writeQueue`/`exclusive`). Uma operação/fila já autorizada pode terminar se houver deploy ou perda de rede depois da checagem. Não anunciar revogação instantânea de I/O em curso.
- **Páginas/builds anteriores à guarda** não passam a obedecê-la por um deploy. O app carrega código remoto, mas uma página antiga ainda aberta pode continuar usando a política antiga. Divulgar recarga/reabertura/atualização, retirar releases afetadas e não tratar controle remoto como revogação criptográfica nem como proteção contra APK modificado. Avaliar o risco residual no incidente e manter bloqueadas versões incompatíveis; só após carregar o site atual o bloqueio passa a valer nesse cliente.

### 5. Merge e deploy autônomos (0.21)

Autorização limitada ao fluxo do plano, **somente** com CI verde no **HEAD exato do PR** (todos os jobs obrigatórios, inclusive Android quando acionados), QA da fase PASS sem FX aberto e `npm run check:sensitive` verde. Se HEAD mudar, reconferir tudo. Registrar evidências e respeitar proteções; não usar `--admin`, force push, squash ou rebase forçado.

```powershell
gh pr merge <n> --merge
gh workflow run deploy.yml -f environment=staging
# Esperar sucesso real do workflow de staging, não só a aceitação do dispatch.
# Com STAGING_ORIGIN definido pelo operador, na pasta web:
npx playwright test --project staging
# Só após e2e de staging verde, na raiz:
gh workflow run deploy.yml -f environment=production -f confirm=production
```

Esperar sucesso de produção e rodar smoke das rotas principais, `/_app/version.json`, `/.well-known/assetlinks.json` e headers de segurança. Guardar IDs dos deployments/versões e bookmark do D1 emitido pelo deploy. Aprovação de `production`, quando exigida, continua humana; **assinatura em `android-release` sempre exige humano**, mesmo com merge/deploy autônomos. Comandos `gh` exigem despacho explícito com shell quando fora do allowlist do router; não contornar autorização da ferramenta. Falha de smoke exige rollback imediato e interrupção por incidente, não avançar para release/Play.

### 6. Rotação e perda de chaves

- **Senhas/acesso ao CI:** retirar acessos comprometidos, cancelar execuções pendentes e pausar aprovação de assinatura. Trocar senhas das cópias PKCS12 em ambiente privado confiável, atualizar os oito secrets afetados e backups, e testar leitura/fingerprint. Trocar senha não revoga cópias de uma chave privada já exfiltrada.
- **Upload key perdida/comprometida:** criar outra chave de upload offline com os mesmos parâmetros RSA 4096/10000 dias, exportar seu certificado público e solicitar **upload key reset** no Play Console conforme instruções vigentes. Depois da confirmação da Play, atualizar somente secrets/backups de upload e `ANDROID_UPLOAD_CERT_SHA256` (na fonte configurada; se variable e secret coexistirem, manter ambos idênticos) e verificar o AAB. Não trocar a chave do app nem `PUBLIC_ANDROID_CERT_SHA256` por causa desse reset.
- **Chave do app perdida:** recuperar de backup testado. Se não houver cópia, a Play pode continuar assinando o que já custodia, mas o APK GitHub não poderá manter a assinatura local. Parar e avaliar com o mantenedor as opções da Play e a continuidade entre fontes; não substituir silenciosamente o certificado.
- **Chave do app comprometida/rotação planejada:** incidente de identidade. Suspender assinatura, retirar releases afetadas e bloquear gravação conforme o risco. Avaliar com a Play o upgrade de chave e a linhagem de assinatura Android, compatibilidade com versões antigas e distribuição GitHub. Reset de upload **não** resolve comprometimento da chave do app. Só após plano verificado ajustar fingerprints legítimos em `ANDROID_APP_CERT_SHA256`, Play, registro do pacote e `PUBLIC_ANDROID_CERT_SHA256`, com deploy e smoke; não prometer revogação universal da chave antiga.

## Verificação

- [ ] H-KEY: duas chaves distintas, validade/aliases/fingerprints anotados, dois backups cifrados em locais independentes com leitura testada; nenhum material privado em git/log/artifact.
- [ ] H-ENV: revisor humano obrigatório, policy de deployment **Tag** `android-v*`, ruleset ativo restringindo create/update/delete, secrets isolados; `ANDROID_APP_CERT_SHA256` e `ANDROID_UPLOAD_CERT_SHA256` configurados, distintos e conferidos na fonte efetiva (variable não vazia antes de secret); revisar código que receberá as chaves antes de aprovar.
- [ ] Build final de produção: `com.openauri.app`, origem HTTPS fixada, cleartext/conteúdo misto/debug desligados, sem navegação adicional; `verifyCapacitorConfig`, verificação de dependências e Licensee verdes. Conferir manifesto mesclado de APK/AAB: USB host opcional, permissões mínimas, `allowBackup=false` e exclusões de backup/transferência. Não usar inventário antigo do shell como prova da release.
- [ ] `apksigner verify --verbose --print-certs <apk>` confirma v2/v3 e SHA-256 do **app** igual a `ANDROID_APP_CERT_SHA256`; `jarsigner -verify <aab>` e `keytool -printcert -jarfile <aab>` confirmam assinatura de **upload** igual a `ANDROID_UPLOAD_CERT_SHA256` e distinta da do app. Conferir hashes dos arquivos baixados contra `SHA256SUMS.txt`, versão/código/commit no manifesto e maior versionCode na Play/histórico.
- [ ] Certificado de assinatura do app no Console coincide com APK GitHub; `PUBLIC_ANDROID_CERT_SHA256` e `/.well-known/assetlinks.json` coincidem. Não confundir certificado do AAB com o APK distribuído pela Play.
- [ ] Smoke sem cabo físico: app abre site; USB/SAF e permissões/tráfego conferidos no artefato; cancelamento do seletor não salva; arquivos vão só ao destino escolhido. Revisar Data safety/política, sem declarar que fontes provaram o tráfego de scripts remotos.
- [ ] Em staging com transporte falso, verificar `enabled=false`, blocklist, aviso/checklist não validado e versão do modal. Manter página aberta, implantar versão nova, confirmar recusa até Recarregar; testar offline/timeout/JSON inválido com e sem última confirmação da mesma versão (aviso com a data quando segue), escrita simples, resgate e fila. Testes em `web/tests/unit/cable/native-freshness.test.ts` e testes nativos do serviço complementam o smoke, não validam hardware.
- [ ] 0.21: CI/QA/varredura, staging, e2e, produção e smoke registrados; aprovação humana não contornada. Registrar release/tag/commit e estado dos controles, sem segredos.

## Rollback

1. **Release Android defeituosa:** registrar evidências públicas sem segredos, interromper rollout na Play e **excluir a GitHub Release** afetada (pela interface ou `gh release delete android-v<versão> --yes`, sem apagar/mover a tag). Fazer deploy do site com a versão em **`ANDROID_WRITE_POLICY.blockedAppVersions`**; risco amplo: `enabled=false`. Excluir a release não desinstala APKs, apaga cópias baixadas ou cancela I/O em andamento. Publicar correção com versão/código maiores, sem reutilizar tag; manter o histórico de códigos retirados.
2. **Smoke/deploy do site falhou:** rollback imediato conforme [`docs/deploy.md`, seção Rollback](../../deploy.md#rollback), depois interromper e abrir relato de incidente. Na pasta `web/`, com configuração gerada e autorização do operador:

   ```powershell
   npx wrangler versions list --env production
   npx wrangler rollback --env production --message "rollback: <motivo>"
   ```

   Se necessário, repetir para jobs. Primeiro código, depois D1 **só se dados/esquema exigirem**, usando bookmark e o procedimento de Time Travel de `docs/deploy.md:89-97`; restauração pode perder gravações posteriores. Rollback do Worker não troca secrets nem restaura D1.
3. Reconferir site, versão, assetlinks e controles Android. Um rollback pode restaurar política permissiva antiga ou retirar a guarda de frescor: escolher versão segura conhecida ou reaplicar bloqueio em um deploy corretivo revisado. Não restaurar gravação apenas para fazer o smoke passar. Manter assinatura suspensa se houver suspeita de chave comprometida e seguir o runbook de incidente.
