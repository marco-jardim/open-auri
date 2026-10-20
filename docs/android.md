# Desenvolvimento do app Android

O app Android é um shell Capacitor 8 do site <https://open-auri.com>, com
transporte USB HID nativo para cabos CB5100 (VID `0x3302`, PID `0x8902`).
Chrome Android e Android WebView não oferecem WebHID; WebUSB não libera as
classes HID e áudio. O app troca apenas o último salto até o USB, sem manter
outro encoder, checklist ou diário.

A especificação e o registro das fases estão em
[`D:\git\open-auri\docs\plans\2026-10-18-android-capacitor-plano.md`](plans/2026-10-18-android-capacitor-plano.md),
especialmente seções 3, 4 e 14 e Anexos B, C, D e G.

## Arquitetura: decisão A

A WebView carrega a origem remota `https://open-auri.com` por `server.url`.
Assim, SSR, autenticação, cookies, CSRF, Turnstile e service worker continuam
no mesmo modelo do navegador. Um deploy atualiza o site, o aviso e a política
de gravação sem republicar o APK.

Essa é uma escolha deliberada: a documentação do Capacitor não recomenda
`server.url` para produção. O app depende do site disponível; offline, só
grava com a última confirmação do servidor para a mesma versão da página
(ver "Controles remotos, página atual e modo offline"). Empacotar um front estático exigiria reescrever SSR e rotas
de servidor e mudaria a origem usada por cookies e CSRF. Uma Trusted Web
Activity não resolveria o acesso USB, pois não fornece a ponte nativa.

Diagrama de componentes da seção 4.2 do plano:

```text
+---------------------- APK (com.openauri.app) -----------------------+
| MainActivity (Capacitor BridgeActivity)                             |
|   WebViewCompatGate -> tela de atualização da WebView               |
|   DownloadBridge -> anexos HTTP com cookies                         |
|   OpenAuriFilesPlugin -> save(name, mime, base64) via SAF            |
|   OpenAuriUsbPlugin -> OriginGuard -> FrameGuard -> HidFraming       |
|     UsbBackend <- AndroidUsbBackend (UsbManager/UsbRequest)         |
|     PermissionBroker, ClaimManager (claim sob demanda)              |
|     HidReportDescriptor, Diagnostics, DevicePicker                  |
+---------------------------------^----------------------------------+
                                  | Capacitor / addWebMessageListener
+---------------- https://open-auri.com (WebView) --------------------+
| Layout -> detectNative -> android-status (aviso e política)         |
|        -> NativeHID (HidLike) -> createClientApp                     |
| Serviço do cabo -> transporte WebHID compartilhado                 |
| Checklist (+ aceite no app) | salvamento de arquivos -> SAF          |
+--------------------------------------------------------------------+
```

A origem da ponte é fixada e conferida de novo por `OriginGuard`.
`allowNavigation` fica vazio; links externos abrem no navegador do sistema.
A WebView precisa de `DOCUMENT_START_SCRIPT`, evitando injeção inline
incompatível com a CSP do site. O release verifica a configuração empacotada,
não apenas a configuração fonte. Não há cleartext em produção, backup do
conteúdo da WebView ou depuração da WebView no release. A detecção JS serve
à UI, não é uma fronteira de segurança: as guardas efetivas são nativas.

## Estado de validação: ainda não validado em hardware

Texto exato do Anexo G.1 em pt-BR:

> **Gravação pelo app ainda não testada num cabo**
>
> O app Android ainda não foi testado num cabo Auri de verdade, então não dá para garantir que a gravação funcione. Ele usa o mesmo protocolo e envia os mesmos bytes que o site no computador e a página oficial da Kuba (testes automáticos conferem isso byte a byte). Só muda o caminho até o USB. Em teoria, o resultado deve ser o mesmo. Se o som ficar estranho depois de gravar, grave o Neutro. Se não resolver, grave o Neutro pelo site no computador (Chrome ou Edge).
>
> Botões e links: **Entendi** · **Relatar resultado** · **Como resgatar**

Os testes comparam os reports de dados dos 11 presets, byte a byte, com a
referência oficial; também comparam desktop e transporte nativo para esses
presets e o Neutro. Isso prova a paridade do protocolo e dos dados, não o
funcionamento físico do USB do celular, do OTG, do descritor real, da rota
de transferência nem da continuidade do áudio.

O framing usa a política `WINDOWS_MAX_OUTPUT` do Anexo D.2: prefixo `0xCB`,
31 bytes de dados e zeros até o maior output report do descritor mais um
byte. Se o descritor tiver somente um output report de 31 bytes, o buffer
terá 32 bytes, também compatível com o envio de Linux e macOS. Essa política
ainda precisa ser confirmada pela captura real da F5; uma divergência de
framing exige correção e nova versão do app, não só deploy do site.

O modal reaparece se a versão do aviso mudar; há banner na página do cabo e
aceite obrigatório no checklist de cada gravação pelo app. O procedimento
de referência está em
[`D:\git\open-auri\docs\android\captura-usb.md`](android/captura-usb.md).
O encerramento do aviso depende da F5, com paridade no fio e validação em
pelo menos dois celulares de fabricantes diferentes, com relatório assinado.
Um teste sintético ou um relato isolado não substitui essa validação.

## Contrato da ponte (Anexo B)

O contrato USB é `bridgeApi: 1`. O schema normativo é
[`D:\git\open-auri\schemas\android-usb-bridge-1.schema.json`](../schemas/android-usb-bridge-1.schema.json).
As respostas, eventos e erros USB são validados contra suas definições nos
testes dos dois lados. O schema USB não descreve o plugin de arquivos.

| Método de `OpenAuriUsb` | Entrada | Resposta |
| --- | --- | --- |
| `getInfo()` | Sem opções | `{ bridgeApi: 1, appVersion, usbHost, webViewVersion }` |
| `requestDevice({ filters })` | Lista de filtros com `vendorId` e/ou `productId` | `{ devices }`; vazio se cancelar, negar ou não houver cabo |
| `getDevices()` | Sem opções | `{ devices }`, somente cabos conectados com permissão |
| `open({ key })` | Chave da conexão | Sem payload |
| `close({ key })` | Chave da conexão | Sem payload |
| `sendReport({ key, reportId, data })` | ID numérico e dados em base64 padrão, sem o ID | Sem payload |
| `diagnostics({ key })` | Chave de dispositivo aberto | `UsbDiagnostics` |
| `addListener(event, callback)` | `connect` ou `disconnect` | Handle com `remove()` assíncrono |

`NativeDeviceInfo` contém `key`, `vendorId`, `productId` e `productName`.
A chave tem o formato `deviceName#n`, vale apenas durante a conexão física
e muda ao reconectar. O nome pode ser vazio. Filtros nunca ampliam o acesso
além do CB5100: filtros vazios significam apenas esse VID/PID. `connect`
não implica permissão; `disconnect` invalida a chave e é emitido antes da
rejeição das operações pendentes.

`UsbDiagnostics` inclui dispositivo, versões do app/Android/WebView,
`rawDescriptorsHex`, `hidInterfaceId`, `endpoints` (endereço, tipo, direção,
`maxPacketSize`), `reportDescriptorHex`, `outputReports` (ID e bytes),
`transfer`, `paddedLength` e `kernelDriverDetached`. `wireLog`, com
`{ atMs, hex }`, só aparece em builds de debug. Esses dados permitem
investigar o framing sem presumir o descritor do cabo real.

`OpenAuriFiles.save({ name, mime, base64 })` retorna `{ saved: boolean }`.
Usa o Storage Access Framework (SAF), sem permissão de armazenamento ampla.
Cancelar o seletor retorna `{ saved: false }`, não um erro. O plugin aceita
até 52.428.800 bytes (50 MiB), higieniza o nome para até 128 pontos de código
e permite JSON, texto, binário, PNG, SVG e gzip. Downloads HTTP e chamadas
JS compartilham um único salvamento por vez.

## Erros nativos e tradução para JS (Anexo C e G10)

Fonte USB:
[`D:\git\open-auri\apps\android\android\app\src\main\java\com\openauri\usb\ErrorCodes.kt`](../apps/android/android/app/src/main/java/com/openauri/usb/ErrorCodes.kt).
As rejeições levam `code` e `message`; a camada web as traduz para os
mesmos nomes de erro usados pelo WebHID.

| Código USB | Situação | Erro JS |
| --- | --- | --- |
| `USB_BAD_ARGS` | ID fora de 0..255, base64 inválido, chave vazia ou filtros malformados | `TypeError` |
| `USB_NOT_FOUND` | Chave, dispositivo ou interface HID ausente | `NotFoundError` |
| `USB_NOT_OPEN` | `sendReport` ou `diagnostics` sem `open`, ou após `close` | `InvalidStateError` |
| `USB_BUSY` | Envio concorrente na mesma chave ou interface ocupada | `InvalidStateError` |
| `USB_PERMISSION_DENIED` | Sem permissão Android, inclusive após revogação | `NotAllowedError` |
| `USB_GUARD_REJECTED` | FrameGuard recusou; motivo na mensagem, nada enviado para esse report | `NotAllowedError` |
| `USB_TRANSFER_FAILED` | Transferência falhou ou foi curta; descritor/framing incompatível | `NotAllowedError` |
| `USB_TIMEOUT` | Transferência não terminou em 1000 ms | `NotAllowedError` |
| `USB_DETACHED` | Cabo removido durante a operação; evento vem antes | `NotAllowedError` |
| `USB_ORIGIN` | Página fora da origem fixada | `SecurityError` |
| `USB_NO_HOST` | Aparelho sem USB host | `NotSupportedError` |

Com exceção de `TypeError`, os nomes acima são de `DOMException`.
Falhas de abertura, thread principal, fechamento, interrupção e falhas
inesperadas sem código específico usam `USB_TRANSFER_FAILED` e preservam
a mensagem para diagnóstico.

Fonte de arquivos:
[`D:\git\open-auri\apps\android\android\app\src\main\java\com\openauri\files\OpenAuriFilesPlugin.kt`](../apps/android/android/app/src/main/java/com/openauri/files/OpenAuriFilesPlugin.kt).
Os códigos de arquivos são separados do enum USB. Incluem os dois códigos
omitidos no Anexo C original e registrados no achado G10:

| Código de arquivos | Situação |
| --- | --- |
| `FILES_BAD_ARGS` | Campos ausentes, MIME não permitido ou base64 inválido |
| `FILES_TOO_LARGE` | Conteúdo acima de 50 MiB, verificado antes da alocação quando possível |
| `FILES_ORIGIN` | Página fora da origem fixada; recusa antes de reservar o SAF |
| `FILES_BUSY` | Já há salvamento em andamento, inclusive um download nativo |
| `FILES_IO` | Falha no seletor, provedor de documentos, stream ou outra exceção sem código específico |

## Framing e FrameGuard (Anexo D)

1. O parser lê o report descriptor HID e calcula os tamanhos de output
   report. Nunca deriva esse tamanho de `wMaxPacketSize`.
2. Se houver endpoint interrupt OUT na interface HID, envia por
   `UsbRequest`. Sem esse endpoint, usa SET_REPORT de controle com
   `bmRequestType=0x21`, `bRequest=0x09`, `wValue=0x02CB`,
   `wIndex=hidInterfaceId` e timeout de 1000 ms.
3. O buffer é `[0xCB] + 31 bytes`, com padding zero até
   `paddedLength = max(outputReports.bytes) + 1` (`WINDOWS_MAX_OUTPUT`).
   O ID é separado dos dados no contrato JS, mas está presente no buffer
   enviado pelo backend nativo.

A guarda é independente para cada chave de dispositivo:

```text
Idle -> report 0 -> Receiving(1)
Receiving(n) -> report n em ordem -> Receiving(n+1)
Receiving(8) -> report 8 -> AwaitCommit
AwaitCommit -> commit exato + payload/preâmbulo/CRC16 válidos
            + pelo menos 2000 ms desde o último commit -> Idle (envia)
Qualquer estado -> sequência inválida ou expirada -> Idle (recusa)
```

São recusados ID diferente de `0xCB`, dados com tamanho diferente de 31,
índice fora de ordem, bytes inválidos ou mais de 2000 ms sem report.
Os nove reports de dados seguem um a um; somente o commit depende da
validação completa do payload remontado. O commit começa com
`01 65 00 01 FF` e completa os 31 bytes com zeros. Uma recusa não desfaz
reports de dados já enviados, mas não encaminha o commit inválido.

O transporte compartilhado mantém os intervalos: 16 ms entre reports,
150 ms de settle antes do commit e 2000 ms entre cabos na fila. Interrupção
não envia commit. O guard nativo é uma defesa adicional, não uma segunda
implementação do encoder nem autorização para contornar o checklist.

## Distribuição e assinatura

As fontes previstas são Google Play (AAB) e GitHub Releases (APK). O pacote
é `com.openauri.app`, com Android 8.0/API 26 ou superior e USB host para
gravar. O site continua utilizável sem USB host, no modo simulado.

O objetivo é a mesma assinatura de app nas duas fontes, permitindo atualizar
de uma para a outra sem desinstalar. A chave de assinatura do app pertence
ao mantenedor e deve ser enviada ao Play App Signing via PEPK antes da
primeira release em teste aberto ou produção. Não aceitar por padrão uma
chave de app gerada pela Play se isso quebrar essa compatibilidade.

- **AAB:** assinado com a chave de upload, com envio manual no Play Console.
- **APK do GitHub:** assinado com a chave do app no Environment protegido
  `android-release`, com aprovação humana. APKs usam esquemas v2 e v3;
  conferir com `apksigner verify --print-certs`.
- **Registro:** pacote e SHA-256 do certificado da chave do app na
  verificação de desenvolvedor Android. Com assinatura única, o registro
  também cobre a distribuição fora da Play.
- **Conferência:** publicar hash SHA-256 do arquivo e fingerprint do
  certificado; são verificações distintas. Uma chave efêmera de CI não
  comprova a assinatura de uma release pública.
- **Exceção:** se a Play não aceitar a chave própria, registrar ambas as
  chaves e documentar explicitamente a incompatibilidade entre fontes.
  Não prometer atualização cruzada nesse caso.

Documentos da Trilha P já disponíveis:

| Documento | Caminho |
| --- | --- |
| Requisitos e políticas atuais da Play | [`D:\git\open-auri\docs\android\play-requisitos.md`](android/play-requisitos.md) |
| Conta, identidade e segurança | [`D:\git\open-auri\docs\android\play-conta.md`](android/play-conta.md) |
| Ficha da loja | [`D:\git\open-auri\docs\android\play-listing.md`](android/play-listing.md) |
| Data safety | [`D:\git\open-auri\docs\android\data-safety.md`](android/data-safety.md) |
| Formulários de conteúdo | [`D:\git\open-auri\docs\android\play-conteudo.md`](android/play-conteudo.md) |

O procedimento operacional de chaves, aprovação, assinatura, publicação,
revogação e controle remoto está em
[`D:\git\open-auri\docs\operacao\runbooks\android-release.md`](operacao/runbooks/android-release.md).

## Controles remotos, página atual e modo offline

As constantes operacionais ficam em
[`D:\git\open-auri\web\src\lib\cable\android-status.ts`](../web/src/lib/cable/android-status.ts).
Não são flags temporárias nem configurações recebidas por push: mudam por
deploy do site, seguindo o runbook de operação.

| Controle | Estado atual | Efeito |
| --- | --- | --- |
| `ANDROID_WRITE_VALIDATED` | `false` | Mantém modal, banner e aceite de gravação não validada; só encerrar depois da F5 aprovada |
| `ANDROID_DISCLAIMER_VERSION` | `1` | Incrementar reabre o modal mesmo para quem já aceitou uma versão anterior |
| `ANDROID_WRITE_POLICY.enabled` | `true` | `false` desliga a gravação pelo app, mantendo uso simulado |
| `ANDROID_WRITE_POLICY.blockedAppVersions` | `[]` | Bloqueia versões específicas ou inferiores a um limite, sem bloquear o desktop |

A lista aceita SemVer exato, como `1.0.0`, ou limite estrito, como `<1.0.3`.
Versão de app inválida é bloqueada; uma entrada malformada na lista bloqueia
todas as versões por segurança. Alterar política não corrige framing nativo:
se houver esse defeito, publicar novo app e bloquear as versões afetadas.

**Gravar pelo app exige a página do deploy atual, confirmada pelo servidor.**
Antes de uma gravação nativa, o serviço consulta `/_app/version.json` e
compara a versão do servidor com a carregada. Esse é um endpoint gerado pelo
SvelteKit no build, não um arquivo fonte do repositório. A implementação está em
[`D:\git\open-auri\web\src\lib\cable\native-freshness.ts`](../web/src/lib/cable/native-freshness.ts).

- A consulta usa `cache: 'no-store'` e `cache-control: no-cache`, com limite
  de 3000 ms incluindo a leitura do JSON, e é feita a cada gravação.
- Versão igual libera a gravação e guarda a última confirmação
  (`oa.cable.nativeLastGood.v1` no `localStorage`: versão do deploy e horário
  da verificação). Falha ao gravar esse registro só gera um aviso no console.
- Versão diferente gera recusa `newer` e apaga essa última confirmação: há
  outro deploy, então recarregue antes de tentar gravar. Nenhum report dessa
  operação é enviado.
- Offline, erro HTTP, JSON inválido, falha de rede ou timeout: a gravação
  segue de forma otimista, sem prazo de validade, só se houver uma última
  confirmação válida para a mesma versão da página. O resultado mostra um
  aviso com a data dessa confirmação. Sem registro, com registro de outra
  versão ou malformado, a recusa é `unavailable`, inclusive para o Neutro.
- O registro também é apagado ao iniciar uma página de outra versão, quando a
  detecção dá `native-write-disabled` e quando o Kit avisa que há deploy mais
  novo (banner do app). Cada gravação nativa grava no diário `freshness`
  (`live` ou `last-good`, com o horário da confirmação).
- Risco residual: mudanças remotas em `ANDROID_WRITE_POLICY` só chegam a um
  aparelho cuja checagem falha (offline, `/_app/version.json` bloqueado, erro
  do servidor) quando ela volta a funcionar e ele carrega o deploy novo. A
  página que grava pode ser o shell que o service worker serve offline,
  possivelmente mais antigo que a última página que o aparelho rodou; a
  limpeza acima limita isso a páginas da mesma versão da última confirmação,
  de um aparelho que não viu deploy mais novo.
- A recusa oferece o botão **Recarregar**. Só no app, um banner também
  avisa quando há nova versão do site. A recarga fica bloqueada enquanto
  uma gravação está em andamento e não é agendada para depois; tente de
  novo ao terminar. Não mate uma sequência para atualizar.
- **Fila com vários cabos:** há uma única checagem de frescor no início de
  cada operação da fila, não antes de cada cabo nem de cada report. Um
  deploy ou perda de rede depois desse ponto não é reavaliado a cada item.
  A próxima operação faz nova checagem. Isso é o limite documentado no m7
  do Q2, não uma garantia de revogação instantânea de fila já iniciada.

Navegação e consulta de conteúdo podem funcionar com o cache disponível;
sem página utilizável, aparece a tela local de falha de rede com tentativa
novamente. A gravação offline só segue com a última confirmação do servidor
para esta mesma versão da página, como descrito acima. Reconecte a rede e use
**Recarregar** para receber a política atual. Se
precisar resgatar o cabo e o app recusar, use o site no computador com
Chrome ou Edge para gravar o Neutro pelo fluxo normal.

## Setup local no Windows

Execute os comandos na raiz `D:\git\open-auri`, em PowerShell.

1. Instale Node.js 22.12 ou superior (CI usa Node 24) e **JDK 21**.
   Configure `JAVA_HOME` para o JDK 21. O doctor também reconhece a
   configuração de Java nas propriedades do usuário do Gradle.
2. Instale Android Studio ou as ferramentas de linha de comando do Android
   SDK. No SDK Manager, instale a plataforma **Android SDK 36**, build-tools
   **36.x** e platform-tools. Configure `ANDROID_HOME` para o SDK instalado
   (`ANDROID_SDK_ROOT` é reconhecido como alternativa). Aceite as licenças
   do SDK no ambiente local.
3. Para testes instrumentados, instale emulador e imagem API 36,
   Google APIs, x86_64, e habilite a virtualização. Emulador é opcional para
   testes JVM, mas não substitui o cabo físico da F5.
4. Instale as dependências e confira o ambiente:

   ```powershell
   Set-Location 'D:\git\open-auri'
   npm ci
   npm run doctor:android
   npm run sync:android
   npm run build:android
   npm run test:android
   ```

O doctor apenas inspeciona Node, JDK e diretórios do SDK; não instala
componentes nem pede credenciais. Seu código está em
[`D:\git\open-auri\tools\android-doctor.mjs`](../tools/android-doctor.mjs).
Para instalar e inspecionar o debug, abra o projeto
`D:\git\open-auri\apps\android\android` no Android Studio. O debug padrão
carrega produção; não habilita cleartext globalmente.

O runner
[`D:\git\open-auri\tools\run-gradle.mjs`](../tools/run-gradle.mjs)
faz o sync do Capacitor antes do Gradle, escolhe o wrapper para Windows e
propaga o código de saída. Use os scripts npm também em automação. O runner
recusa exclusão de tarefas, init/settings scripts, mudança de projeto,
propriedades arbitrárias, dry run e opções que contornem verificações.
`--offline` só restringe a resolução de dependências do build; não libera
gravação USB offline. Os cuidados de metadata, Robolectric e verificação
de assets estão em
[`D:\git\open-auri\docs\android-build-security.md`](android-build-security.md).

## Scripts disponíveis na raiz

Fonte: [`D:\git\open-auri\package.json`](../package.json). Todos os comandos
abaixo são executados a partir da raiz.

| Comando | Finalidade |
| --- | --- |
| `npm run doctor:android` | Verificar Node, JDK 21, SDK 36 e componentes opcionais do emulador |
| `npm run sync:android` | Sincronizar Capacitor para produção, sem executar Gradle |
| `npm run build:android` | Sync de produção e `:app:assembleDebug` |
| `npm run build:android:e2e` | Sync do alvo e2e e debug para servidor local do emulador |
| `npm run build:android:staging` | Sync do alvo staging e debug; exige `STAGING_ORIGIN` |
| `npm run build:android:release` | Sync de produção, `:app:verifyCapacitorConfig`, bundle e APK de release |
| `npm run test:android` | Testes JVM `:app:testDebugUnitTest` e cobertura `:app:koverVerifyDebug` |
| `npm run test:android:release` | Ensaio local de assinatura de APK/AAB com chaves efêmeras distintas e verificação dos metadados de release; exige JDK 21 e SDK |
| `npm run lint:android` | Android Lint na variante debug |
| `npm run test:android:device` | Testes instrumentados em emulador/aparelho conectado |
| `npm run typecheck:android` | TypeScript do workspace Android |
| `npm run icons:android` | Regenerar ícones e splash nativos |
| `npm run notices:android` | Executar o gerador Node de avisos de licenças a partir de um relatório Licensee existente, após `npm run build:android:release`; não executa Gradle |
| `npm run usb:golden` | Validar capturas USB e comparar wire logs com o golden, offline; exige argumentos conforme o guia de captura |
| `npm run play:assets` | Regenerar PNGs da loja a partir da arte e screenshots existentes; `-- --check` valida sem escrever |
| `npm run test:transport` | Regressão do transporte compartilhado |
| `npm run test:tools` | Testes das ferramentas Node, incluindo tooling Android |
| `npm run test:web:unit` | Testes web unitários e de componentes |
| `npm run build:web` | Build web necessário para integração/servidor local |
| `npm run test:web:int` | Integração web, após o build |
| `npm run test:web:e2e -- --grep android-bridge` | E2E da ponte, filtrados pelo nome da suíte |
| `npm run check:all` | Lint e checagens de tipos do núcleo, Android e web |
| `npm run check:sensitive` | Verificação de conteúdo sensível antes de compartilhar alterações |

Para atualizar os avisos Android, execute `npm run build:android:release` e
depois `npm run notices:android`. O segundo comando executa apenas o gerador Node
[`D:\git\open-auri\tools\android-notices.mjs`](../tools/android-notices.mjs): lê o relatório Licensee já gerado no build
e atualiza os avisos; não gera o relatório nem dispara outro build Gradle.

## Testes por camada

Não confunda paridade automatizada com validação do hardware. Execute
Gradle e builds web em série quando compartilhar o mesmo checkout.

| Camada | Cobertura e execução |
| --- | --- |
| Kotlin unitário | Parser HID, framing, CRC16, FrameGuard, erros, concorrência, timeout e backend falso; `npm run test:android` |
| Robolectric | Permissão, ciclo de vida, origem, plugins USB/arquivos, downloads e política do manifest, sem depender de aparelho; incluído em `npm run test:android` |
| Kover | A mesma execução verifica pelo menos 90% de linhas e branches nos pacotes USB e arquivos; não pule `:app:koverVerifyDebug` |
| Web unitário e componentes | Detecção nativa, handshake/schema, erros, estado/política, checklist, aviso, arquivos, frescor e recarga; `npm run test:web:unit` |
| Paridade nativa | Transporte real injetado com `NativeHID` versus HID falso de desktop: 11 presets e Neutro, 1 e 2 cabos, bytes, commit e tempos iguais |
| E2E `android-bridge` | Playwright desktop/mobile com o `native-bridge.js` real do Capacitor e backend USB falso; aviso, gravação, recusa, reload e downloads; `npm run test:web:e2e -- --grep android-bridge` |
| Instrumentados | WebView Android real contra o servidor local com CSP real, ponte, origem, arquivos e atualização/offline; `npm run test:android:device`, também no job de CI `android-emulator` |
| F5 física | Captura USB de referência, paridade de rota/padding e testes em dois fabricantes; depende de cabo e intervenção humana |

Referências de testes existentes:

- JVM: `D:\git\open-auri\apps\android\android\app\src\test\java\com\openauri`.
- Paridade web:
  [`D:\git\open-auri\web\tests\unit\cable\native-parity.test.ts`](../web/tests/unit/cable/native-parity.test.ts).
- E2E:
  [`D:\git\open-auri\web\tests\e2e\android-bridge.spec.ts`](../web/tests/e2e/android-bridge.spec.ts).
- Referência oficial:
  [`D:\git\open-auri\test\fixtures\eq0xcb.reference.json`](../test/fixtures/eq0xcb.reference.json).

O e2e de navegador não executa o backend Android nem valida USB físico.
O emulador prova a integração com uma WebView real, mas também não substitui
a F5. Robolectric usa SDK verificado e resolução offline, conforme o
documento de segurança do build; uma dependência ausente deve falhar, não
ser baixada por um resolvedor não verificado durante o teste.

## Troubleshooting

| Sintoma | Ação segura |
| --- | --- |
| Tela pedindo atualização da WebView | Atualize Android System WebView ou o provedor Chrome ativo. A baseline atual é Chromium 111 e é obrigatório oferecer `DOCUMENT_START_SCRIPT`; só ter Android recente não garante isso |
| Aparelho sem USB host/OTG | Confirme suporte do fabricante e adaptador USB-C/OTG de dados. Sem `FEATURE_USB_HOST`, o app fica simulado; um cabo apenas de carga não resolve |
| Nenhum cabo listado | Verifique encaixe, adaptador e VID/PID CB5100. Reconecte e use Conectar; outro chip não é aceito. Não instale driver genérico para trocar a classe do dispositivo |
| Permissão negada ou revogada | Reabra o seletor pelo gesto Conectar e conceda a permissão Android. Uma lista vazia pode ser cancelamento normal; reconectar muda a chave e exige nova seleção |
| `USB_BUSY` / claim falhou | Encerre gravação ou outra ferramenta que esteja usando a interface HID, solte/reconecte e tente novamente. O claim é sob demanda e solta ocioso; não force o claim das interfaces de áudio |
| `USB_NOT_OPEN` no diagnóstico | Selecione e abra a conexão pelo fluxo do cabo antes de pedir diagnóstico; depois de desconectar, não reutilize a chave antiga |
| `USB_GUARD_REJECTED`, timeout ou interrupção | Não repita commit manualmente. Preserve diagnóstico e diário; tente o Neutro pelo fluxo normal. Se necessário, faça o resgate no desktop e relate o resultado |
| Recusa após deploy / versão nova | Conecte a rede e use Recarregar na recusa ou no banner do app, sem gravação em andamento. Só então refaça o checklist; não limpe proteções nem tente gravar de cache antigo |
| Offline | Só grava com a última confirmação do servidor para esta mesma versão da página; sem ela, recupere a conexão. A tela local permite tentar carregar novamente |
| `FILES_BUSY` | Termine ou cancele o seletor de salvamento já aberto antes de iniciar outra exportação |
| Falha no doctor ou Gradle | Confira JDK 21, SDK 36, variáveis de ambiente e licenças. Para falha de checksum, siga o procedimento de revisão de metadata; não desligue a verificação |

Para investigar, copie o JSON de **Diagnóstico USB** na camada Engenharia
e registre aparelho, Android, WebView, versão do app, origem da instalação,
curva e efeito no áudio. Não publique identificadores ou outros dados
pessoais presentes na captura. Use
<https://github.com/marco-jardim/open-auri/issues/new?template=android-cable-report.yml>.
O wire log de debug é evidência de teste, não prova isolada de escrita
bem-sucedida no cabo.

## Fora de escopo e motivos

- **iOS e iPadOS:** não há rota pública viável para HID genérico no iPhone.
  CoreHID atende macOS 15 ou superior, External Accessory exige MFi e
  USBDriverKit é restrito a iPads com chip M e entitlement da Apple.
  Reempacotar o site com Capacitor para iOS não cria essa API USB.
- **Abrir automaticamente ao conectar o cabo:** o usuário inicia o app e
  escolhe a conexão explicitamente. Evita assumir uma gravação ou tomada
  da interface só porque um dispositivo de áudio foi conectado.
- **Upload automatizado para a Play:** os uploads e formulários continuam
  manuais, guiados pela Trilha P; build e assinatura não equivalem a
  publicação aprovada na loja.
- **Outros chips além do CB5100:** protocolo, filtros, framing e guarda
  foram delimitados para esse chip/firmware. Outro VID/PID ou outro
  protocolo exige pesquisa e validação próprias, não ampliar os filtros.
