# Teste parcial do app Android em cabo Kuba Auri

Data: **29/10/2026**. Estado: **1 de 2 fabricantes testado (Samsung)**.
Este relatório registra evidência real de prévia, gravação persistente e
restauração nesta bancada, não a aprovação completa da F5 do plano Android.
`ANDROID_WRITE_VALIDATED` permanece `false`; modal, banner, checklist e link de
relato continuam ativos. Não é relatório assinado de encerramento da F5.

## Ambiente e versões

| Item | Identificação |
| --- | --- |
| Celular | Samsung SM-A705MN, Galaxy A70 |
| Sistema | Android 11 |
| Android System WebView | 155.0.8059.43 |
| Cabo | Kuba Auri real, VID `0x3302`, PID `0x8902` |
| APK | Debug com a correção do claim HID, identificado na coleta como versionName `1.0.2`, versionCode `1` |
| Identidade do build corrigido | SHA-256 `3d6c169555fd6a251b66cfde5ce7836929956bffa118227ee7d57ce91eb899f5`, gerado em 29/10/2026 |
| Site | `open-auri.com`, versão publicada em 29/10/2026 |

A versão numérica do APK debug não mudou no reteste; o hash identifica o build
com a correção. A versão 1.0.3 da branch não deve ser confundida com um APK de
release instalado e testado nesta coleta. O registro disponível identifica o
site por domínio e data de publicação, não por um hash imutável do deploy.

## Falha inicial e correção

O primeiro `open` falhou com `USB_TRANSFER_FAILED`,
`controlTransfer failed (-1)`, antes de qualquer `sendReport` ou commit.
A interface HID **3** estava presa ao driver **`usbhid`**. A correção faz o
claim forçado dessa interface antes da leitura do descritor HID. Depois da
instalação do debug corrigido e da reconexão física, `open` e o envio dos nove
reports foram exercitados com sucesso pela UI. Não se contornou a permissão
USB nem o checklist para as gravações.

## Procedimento

1. Usar o Padrão Auri salvo como referência acústica inicial, mantendo posição
   dos fones, microfone, volume e cadeia de reprodução.
2. Pelo app, aplicar uma prévia de Neutro com PK em 4.000 Hz, ganho −12 dB,
   Q 1,4 e preamp −0,5 dB, CRC `0x8097`: nove reports de dados, sem commit.
   Comparar duas capturas com a predição dos coeficientes efetivamente enviados.
3. Desligar a prévia escolhendo **Manter até desconectar**. Medir o áudio ainda
   aplicado, depois desconectar/reconectar fisicamente sem nova escrita e medir
   o retorno à referência. Isso não testa a opção Voltar à curva salva.
4. Gravar uma vez a curva de teste, pelo checklist normal: nove dados e um
   commit. Reconectar fisicamente e comparar com a prévia para testar persistência.
5. Carregar **Padrão Auri** (`padrao`, preamp −2,8 dB, CRC `0x1970`), conferir
   o checklist e gravar uma vez. Comparar os nove payloads e o commit registrados
   na ponte com a referência Windows e medir novamente após reconexão.
6. Encerrar com Padrão Auri restaurado, confirmado acusticamente, volume USB
   5/15 e player parado. A etapa acústica final não enviou HID.

## Método acústico e predição

Ruído rosa reproduzido pelo próprio celular, com os fones encostados em um
**HyperX QuadCast S**. Capturas analisadas em terços de oitava, com Welch,
janela Hann, FFT 32.768 e passo 16.384, a 48 kHz. A decisão usa as oito bandas
nominais de **2 a 10 kHz**, sem normalização, offset ajustado, subtração do piso
de ruído ou calibração absoluta de SPL. São deltas relativos, não uma medição
calibrada da resposta em frequência dos fones.

A predição decodifica os coeficientes **Q27** das seções e o preamp **Q23** do
payload real, com taxa efetiva do DSP de 96 kHz. Integra separadamente a potência
de cada curva por banda, ponderada por `1/f` (ruído rosa), antes de calcular o
delta contra o Padrão Auri. Inclui ambos os preamps: não é correto comparar o
delta acústico diretamente com os −12 dB do PK isolado. Critério da predição:
resíduos das duas capturas dentro de **±1,5 dB** em todas as oito bandas, sem
ajuste de nível. O controle negativo com PK em 2 kHz teve RMS de cerca de
5,40 dB, contra 0,46/0,47 dB do modelo correto.

## Resultados

Valores arredondados a duas casas; os limites abaixo se referem apenas a 2–10 kHz.

| Etapa | Resultado | Alcance da evidência |
| --- | --- | --- |
| Prévia aplicada, sem flash | Resíduo máximo **0,88 dB** contra a predição Q27/Q23 (0,821/0,876 dB); RMS 0,464/0,471 dB | Curva acústica compatível; nove dados, zero commit |
| Desligar com Manter até desconectar | Diferença máxima contra prévia 0,101/0,075 dB | Prévia mantida até a desconexão, não restauração imediata |
| Volatilidade após reconexão | **≤ 0,82 dB** da referência, arredondado (0,795/0,824 dB), dentro de ±1 dB | Retorno ao Padrão Auri sem nova escrita |
| Gravação persistente | **≤ 0,16 dB** contra a prévia (0,104/0,157 dB), após reconexão | Nove dados + um commit; repetibilidade 0,143 dB |
| Restauração por gravação | **9/9** payloads de 31 bytes idênticos byte a byte ao primeiro write `padrao` da referência Windows; um commit exato | Comparação na entrada da ponte nativa, não no fio Android |
| Restauração acústica após reconexão | **≤ 0,82 dB** da referência, arredondado (0,462/0,823 dB), dentro de ±1 dB | Padrão Auri restaurado nesta bancada; repetibilidade 0,862 dB |

## Limitações

- Um celular, um fabricante. Não generaliza para outros Samsung, Androids,
  adaptadores OTG ou fabricantes.
- Bytes conferidos na **entrada da ponte nativa, pelo logcat**, não numa captura
  USB no fio no Android. Paridade dos payloads não prova o framing físico completo.
- O **`wireLog` do Diagnóstico ficou vazio**: navegar à página de diagnóstico
  recarregou o documento e reabriu a sessão. Não foi substituído por um log
  reconstruído. A coleta não preservou uma sessão íntegra com os reports.
- Sem leitura de volta do DSP ou flash. Persistência e restauração têm evidência
  acústica, não prova de cada detalhe da aritmética interna ou de toda a memória.
- Acoplamento fone/microfone e ponderação acústica dentro de cada banda limitam a
  conclusão. Abaixo de 2 kHz houve SNR insuficiente em pelo menos um estado.
  Em 12,5 kHz, fora do critério, o resíduo foi cerca de 2,98 dB com SNR alto;
  sua causa não foi isolada. Não há aprovação de todo o espectro.
- Padrão Auri é o preset `padrao` do projeto, não uma restauração de fábrica
  comprovada. A vida útil da flash e a segurança auditiva não foram validadas.

## O que ainda falta

1. Testar pelo menos um segundo celular de **outro fabricante**.
2. Obter captura Android **no fio**, conforme o
   [procedimento de captura USB](captura-usb.md), e/ou um `wireLog` íntegro sem
   perder a sessão. Um `wireLog` útil não dispensa a paridade no fio exigida pela F5.
3. Consolidar as evidências e obter o relatório assinado e as demais aprovações
   da F5 antes de mudar `ANDROID_WRITE_VALIDATED`. G.6 é o texto de encerramento,
   ainda não aplicável. A versão do aviso foi incrementada de 1 para 2, conforme
   o runbook, para que o novo estado seja reconhecido uma vez.

Se o som ficar estranho, grave o Neutro pelo app. Se não resolver, grave o Neutro
pelo site no computador, no Chrome ou Edge.
[Relatar resultado](https://github.com/marco-jardim/open-auri/issues/new?template=android-cable-report.yml).

## Inventário das ocorrências e decisões editoriais

Busca antes da edição em `web/src`, `web/tests`, `docs`, `tools`, `test` e
`apps/android`, ampliada para `web/messages` e README. Padrões: `ainda não foi
testad`, `not been tested`, `não testada`, `untested`, `android-untested`, `G.1`,
`G.5`, `ANDROID_WRITE_VALIDATED` e `ANDROID_DISCLAIMER_VERSION`. O material
local consultado foi o resultado consolidado de REPORT.md e PREDICTION.md da
coleta de prévia 4 kHz, além do registro funcional para a identidade do APK.
Não se publicam binários nem links para caminhos locais dessa coleta.

| Ocorrências por arquivo/grupo | Decisão |
| --- | --- |
| `web/messages/pt-BR.json`, `en-US.json`: modal, banner, callout, aceite e bloqueio | Atualizar nos dois idiomas; manter risco, resgate e relato |
| `web/src/lib/content/docs/pt-BR.ts`, `en-US.ts`: bloco `android-validacao` | Atualizar teste parcial e pendências; preservar âncoras |
| `web/src/lib/content/docs/legal-notice.ts` | Substituir a negação geral de teste real por teste limitado, sem retirar isenção de garantia |
| `web/src/lib/cable/android-status.ts`, `docs/android.md`: versão/estado | Versão 2, estado `false`, relatório e 1 de 2 fabricantes; critérios finais intactos |
| `docs/plans/2026-10-18-android-capacitor-plano.md`: G.1, G.2, G.3, G.5 | Atualizar fonte normativa dos textos exatos; G.4 e G.6 mantidos; menções anteriores preservadas como estado inicial/histórico |
| `tools/android-artifacts.mjs`, `README.md`, `docs/android/play-listing.md` | Mesmo G.5 revisado, sem alegar validação plena; atualizar descrições curtas e explicação USB da Play |
| `docs/android/play-console-preenchimento.md`, `play-console-passos.md` | Atualizar cópias operacionais, notas e instruções de captura para não republicar o aviso obsoleto |
| `test/tools/play-listing.test.mjs`, `web/tests/unit/content/docs-android.test.ts`, `web/tests/unit/cable/android-status.test.ts`, `checklist-android.svelte.test.ts`, `web/tests/e2e/android-bridge.spec.ts`, `play-screenshots.spec.ts` | Atualizar expectativas textuais/versão, mantendo verificações exatas e limites |
| `test/tools/docs-consistency-android.test.mjs` | Atualizar título da seção de estado; manter igualdade exata G.1/G.5 |
| `test/tools/android-artifacts.test.mjs`, `test/android-release/dryrun.mjs`, `web/tests/unit/app/native-mount.test.ts` | Manter comparação dinâmica com o plano revisado |
| `web/src/lib/paraglide/messages/*` | Gerados a partir dos catálogos pelo pipeline web; não editar manualmente |
| `web/src/lib/cable/checklist.ts`, `types.ts`; componentes `AndroidUntestedNotice`, `AndroidAppCallout`, `PreWriteChecklist`, `LiveChecklist`, `ConfirmLever`, `CableBlind`, `CableAB` | Manter nomes, IDs e guardas; texto vem dos catálogos |
| Testes unitários `native-back`, `usb-diagnostics`, `checklist`, `checklist-android`, `android-untested-notice`, `android-callout` | Manter testes comportamentais e IDs, que não afirmam ausência de teste físico |
| `docs/seguranca.md`, `docs/operacao/runbooks/android-release.md` | Manter risco de gravação antes da validação completa e regra de encerramento/reabertura |
| `docs/android/smoke-lancamento.md`, planos de progresso/handover e modo sem flash | Manter evidência histórica, referências a etapas ou controles operacionais, não texto vigente do aviso |
| `apps/android/.../DisclaimerTest.kt`, `BridgeBootTest.kt` | Não alterar Kotlin neste trabalho. Os rótulos internos ainda dizem untested; as expectativas literais de título em DisclaimerTest precisam acompanhar o novo título numa alteração Kotlin autorizada antes de rodar esse teste instrumentado |
