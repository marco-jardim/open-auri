# Ficha da loja Android (P2)

Textos para copiar no Play Console. Os identificadores dos três campos seguem em inglês nos dois idiomas. Copie somente o conteúdo dos blocos, sem as cercas. Os limites e textos obrigatórios são conferidos por `test/tools/play-listing.test.mjs`, com base em `play-requisitos.md`. Desde 01/11/2026 (`ANDROID_WRITE_VALIDATED = true`), a ficha não traz mais o aviso do Anexo G.5 de teste num só celular; o teste também confere que ele não volta.

## Campos compartilhados

- Categoria: Music & Audio / Música e áudio
- Tags sugeridas: equalização, áudio, ferramentas de áudio
- E-mail de contato: contato público do desenvolvedor (definido no Play Console)
- Site: https://open-auri.com
- Política de privacidade: https://open-auri.com/privacidade

O contato é um placeholder para preenchimento no Console, não um endereço a publicar neste arquivo. Confirme as tags disponíveis no Console antes do envio.

## Capturas e regeneração (P3)

Os dois idiomas (`pt-BR` e `en-US`) têm quatro conjuntos, totalizando **64 PNGs** com ícone e feature graphic:

| Conjunto | Capturas por idioma | Viewport CSS e DPR | PNG | Pasta dentro de `screenshots/<locale>/` |
| --- | --- | --- | --- | --- |
| Telefone | 8 | 360x640, DPR 3; cenas 7 e 8: 540x960, DPR 2 | 1080x1920 | a própria pasta, sem subpasta |
| Tablet de 7 polegadas | 8 | 720x1280, DPR 1,5 | 1080x1920 | `tablet-7/` |
| Tablet de 10 polegadas | 8 | 900x1600, DPR 1,6 | 1440x2560 | `tablet-10/` |
| Desktop / telas grandes | 7 | 1280x720, DPR 1,5 | 1920x1080 | `desktop/` |

As seis cenas de navegação são editor, Cabo sem conexão, Comparar, Soe como X, Comunidade e Teste cego (`1-editor` a `6-teste-cego`). Telefone e tablets também incluem `7-native-connect`: após conectar pelo USB nativo Android, a interface navega para Curva e ativa Ouvir no cabo, com Salvar no cabo disponível. Todos os conjuntos incluem `8-cable-compare`, com Comparar no cabo A/B ativo, sem gravar. Desktop usa o navegador com WebHID, sem bridge Android e sem a cena 7. As capturas largas enquadram os instrumentos, gráficos e controles por rolagem real, sem esconder ou reposicionar a interface. Em Soe como X, os conjuntos largos importam um CSV de exemplo pela interface e executam o solver real, para mostrar resultados em vez de gráficos vazios; não é uma medição de hardware real.

Todas as capturas são PNG RGB sem alpha, até 8 MB, com proporção exata 9:16 (telefone/tablets) ou 16:9 (desktop). Os lados do tablet de 7 polegadas ficam entre 320 e 3840 px; os de 10 polegadas e desktop, entre 1080 e 7680 px. O validador exige os tamanhos e nomes exatos da tabela, 8 cenas por conjunto Android e 7 no desktop (dentro do limite de 4 a 8).

`3-comparar` deve manter o botão Como funciona / How it works sem sobrepor o texto acima do título; nos layouts largos o enquadramento privilegia as pistas e o gráfico, após conferir o cabeçalho. `7-native-connect` deve mostrar Ouvir no cabo / Hear on the cable ligado e Salvar no cabo / Save to cable visível, sem diálogo de confirmações. A spec confere antes o painel USB Android conectado na página Cabo, sem aviso de teste nem item extra de confirmação do Android, e então navega para Curva, onde fica o switch. Não montar uma composição nem alterar o app para a captura. `8-cable-compare` deve mostrar Comparar no cabo / Compare on the cable, as opções A/B e os controles da sessão ativa; a spec também confere o texto sobre tocar na memória sem gravar antes de começar. Os dispositivos são falsos, pelo bridge Capacitor real ou pela fronteira WebHID; as imagens não comprovam conexão ou gravação em hardware real.

Regenerar a partir da raiz do repositório, em PowerShell. Os comandos abaixo capturam cada conjunto nos dois idiomas; `--grep` permite repetir somente o conjunto desejado. Sem `--grep`, a spec captura todos os quatro conjuntos no projeto `mobile`, mas usa emulação de desktop (sem touch/UA Android) no conjunto desktop. Não precisa alterar a configuração dos projetos.

```powershell
$env:CI = '1'
$env:PLAY_SCREENSHOTS = '1'
$env:NODE_OPTIONS = '--max-old-space-size=6144'
Remove-Item Env:STAGING_ORIGIN -ErrorAction SilentlyContinue
Set-Location web
npx playwright test tests/e2e/play-screenshots.spec.ts --project=mobile --workers=1 --grep 'phone'
if ($LASTEXITCODE -ne 0) { throw 'Falha na captura de telefone' }
npx playwright test tests/e2e/play-screenshots.spec.ts --project=mobile --workers=1 --grep 'tablet-7'
if ($LASTEXITCODE -ne 0) { throw 'Falha na captura de tablet de 7 polegadas' }
npx playwright test tests/e2e/play-screenshots.spec.ts --project=mobile --workers=1 --grep 'tablet-10'
if ($LASTEXITCODE -ne 0) { throw 'Falha na captura de tablet de 10 polegadas' }
npx playwright test tests/e2e/play-screenshots.spec.ts --project=mobile --workers=1 --grep 'desktop'
if ($LASTEXITCODE -ne 0) { throw 'Falha na captura de desktop' }
Set-Location ..
npm run play:assets
if ($LASTEXITCODE -ne 0) { throw 'Falha na normalização das artes' }
node tools/play-assets.mjs --check
if ($LASTEXITCODE -ne 0) { throw 'Falha na validação das artes' }
npm run test:tools
if ($LASTEXITCODE -ne 0) { throw 'Falha nos testes das ferramentas' }
```

As capturas ficam em `docs/android/play-assets/screenshots/<locale>/`, nas subpastas da tabela; `play:assets` renderiza ícone/feature graphic e normaliza as capturas existentes, não abre o app para recapturá-las. Todos os conjuntos são obrigatórios para normalizar/validar; uma pasta ausente ou um nome extra falha sem criar placeholders. Aprovar visualmente os quatro conjuntos nos dois idiomas após a execução, inclusive os controles e gráficos nas telas largas. Para o fluxo do revisor e os caminhos exatos de denúncia/ocultação, usar [play-conteudo.md](./play-conteudo.md#2-acesso-ao-app); a captura USB simulada não substitui a conta de revisão nem o vídeo obrigatório.

## pt-BR

### Title

```text
open-auri
```

### Short description

```text
App não oficial para o cabo Auri: EQ, prévia ao vivo e gravação pelo USB.
```

### Full description

```text
Conecte o cabo Kuba Auri por USB-C/OTG e grave curvas de equalização no cabo pela camada USB nativa do Android, que o navegador do celular não oferece. O transporte USB nativo permite selecionar o cabo e pedir permissão ao Android. Em Ouvir no cabo, a curva do editor toca ao vivo, sem gravar na memória flash. Em Comparar no cabo, alterne A/B na memória, também sem gravar. Ao desconectar, o cabo volta à curva salva. Para persistir a curva, use Salvar no cabo e confirme o checklist: a gravação nunca é automática. Há também Diagnóstico USB e exportação de arquivos pelo seletor do sistema.

Projeto independente: open-auri não é oficial nem endossado pela Kuba e não tem afiliação com ela ou qualquer fabricante. Crie, explore e compare curvas de equalização. Acesse a biblioteca de curvas e presets, compare respostas e participe da comunidade.

Não há leitura de volta do cabo. A vida útil da memória flash é desconhecida.

Código aberto sob AGPL-3.0, com código-fonte e contribuições em:
https://github.com/marco-jardim/open-auri

O protocolo foi estudado para fins de interoperabilidade. Use por sua conta e risco: não nos responsabilizamos por danos ao cabo, ao fone ou à sua audição.

Requisitos: Android 8 ou mais recente, aparelho com USB host/OTG, cabo compatível e Android System WebView atualizado. É necessária conexão com a internet para carregar o conteúdo e usar os recursos online. Destinado a pessoas com 18 anos ou mais.

Som estranho depois de gravar? Grave o Neutro pelo app; se não resolver, pelo site no computador (Chrome ou Edge). Para relatar resultados, use o formulário https://github.com/marco-jardim/open-auri/issues/new?template=android-cable-report.yml e informe o aparelho, as versões do Android e do app e o JSON do Diagnóstico USB. Não inclua dados pessoais no relato.

Consulte a seção Segurança dos dados (Data safety) desta ficha e a política de privacidade para conhecer os dados coletados e compartilhados, as finalidades e as opções de exclusão. O arquivo de áudio usado na prévia fica no aparelho.

Site: https://open-auri.com
Privacidade: https://open-auri.com/privacidade
```

## en-US

### Title

```text
open-auri
```

### Short description

```text
Unofficial Auri cable app: EQ, live preview and writing over USB.
```

### Full description

```text
Connect the Kuba Auri cable through USB-C/OTG and write EQ curves to the cable through Android's native USB layer, which the phone browser does not provide. The native USB transport lets you select the cable and request Android permission. Hear on the cable plays the editor curve live, without writing to flash. Compare on the cable switches A/B in memory, also without saving. Unplugging restores the saved curve. To persist a curve, use Save to cable and confirm the checklist: writing is never automatic. USB Diagnostics and file exports through the system picker are also available.

Independent project: open-auri is not official or endorsed by Kuba and is not affiliated with Kuba or any manufacturer. Create, explore and compare EQ curves. Browse the curve and preset library, compare responses and take part in the community.

There is no readback from the cable. The lifespan of its flash memory is unknown.

Open source under AGPL-3.0, with source code and contributions at:
https://github.com/marco-jardim/open-auri

The protocol was studied for interoperability. Use at your own risk: we are not responsible for damage to the cable, headphones or your hearing.

Requirements: Android 8 or newer, a device with USB host/OTG, a compatible cable and an up-to-date Android System WebView. An internet connection is needed to load content and use online features. Intended for people aged 18 or over.

Sound off after writing? Write Neutral from the app; if unresolved, use the desktop site (Chrome or Edge). To report results, use the form https://github.com/marco-jardim/open-auri/issues/new?template=android-cable-report.yml and include your device, Android and app versions, and the USB Diagnostics JSON. Do not include personal data in the report.

See the Data safety section of this listing and the privacy policy for collected and shared data, purposes and deletion options. The audio file used for previews stays on your device.

Website: https://open-auri.com
Privacy policy: https://open-auri.com/privacidade
```
