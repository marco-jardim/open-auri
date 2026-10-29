# Ficha da loja Android (P2)

Textos para copiar no Play Console. Os identificadores dos três campos seguem em inglês nos dois idiomas. Copie somente o conteúdo dos blocos, sem as cercas. Os limites e avisos são conferidos por `test/tools/play-listing.test.mjs`, com base em `play-requisitos.md` e no Anexo G.5 do plano Android.

## Campos compartilhados

- Categoria: Music & Audio / Música e áudio
- Tags sugeridas: equalização, áudio, ferramentas de áudio
- E-mail de contato: contato público do desenvolvedor (definido no Play Console)
- Site: https://open-auri.com
- Política de privacidade: https://open-auri.com/privacidade

O contato é um placeholder para preenchimento no Console, não um endereço a publicar neste arquivo. Confirme as tags disponíveis no Console antes do envio.

## Capturas e regeneração (P3)

Os dois idiomas (`pt-BR` e `en-US`) têm quatro conjuntos, totalizando **56 PNGs** com ícone e feature graphic:

| Conjunto | Capturas por idioma | Viewport CSS e DPR | PNG | Pasta dentro de `screenshots/<locale>/` |
| --- | --- | --- | --- | --- |
| Telefone | 7 | 360x640, DPR 3; USB conectado: 540x960, DPR 2 | 1080x1920 | a própria pasta, sem subpasta |
| Tablet de 7 polegadas | 7 | 720x1280, DPR 1,5 | 1080x1920 | `tablet-7/` |
| Tablet de 10 polegadas | 7 | 900x1600, DPR 1,6 | 1440x2560 | `tablet-10/` |
| Desktop / telas grandes | 6 | 1280x720, DPR 1,5 | 1920x1080 | `desktop/` |

As seis cenas de navegação são editor, Cabo sem conexão, Comparar, Soe como X, Comunidade e Teste cego (`1-editor` a `6-teste-cego`). Telefone e tablets também incluem `7-native-connect`, com USB nativo Android conectado. Desktop usa o navegador com WebHID na cena `2-cabo`, sem bridge Android e sem a cena nativa. As capturas largas enquadram os instrumentos, gráficos e controles por rolagem real, sem esconder ou reposicionar a interface. Em Soe como X, os conjuntos largos importam um CSV de exemplo pela interface e executam o solver real, para mostrar resultados em vez de gráficos vazios; não é uma medição de hardware real. Os arquivos de telefone e seus caminhos continuam iguais.

Todas as capturas são PNG RGB sem alpha, até 8 MB, com proporção exata 9:16 (telefone/tablets) ou 16:9 (desktop). Os lados do tablet de 7 polegadas ficam entre 320 e 3840 px; os de 10 polegadas e desktop, entre 1080 e 7680 px. O validador exige os tamanhos e nomes exatos da tabela, 7 cenas por conjunto Android e 6 no desktop (dentro do limite de 4 a 8).

`3-comparar` deve manter o botão Como funciona / How it works sem sobrepor o texto acima do título; nos layouts largos o enquadramento privilegia as pistas e o gráfico, após conferir o cabeçalho. `7-native-connect` deve mostrar o painel USB Android e o estado Conectado / Connected, mantendo o aviso de teste limitado a um celular visível, não o diálogo de confirmações. O dispositivo dessa captura é falso, ligado pelo bridge Capacitor real; a imagem não comprova conexão ou gravação em hardware real.

Regenerar a partir da raiz do repositório, em PowerShell. Os comandos abaixo capturam cada conjunto nos dois idiomas; `--grep` permite repetir somente o conjunto desejado. Sem `--grep`, a spec captura todos os quatro conjuntos no projeto `mobile`, mas usa emulação de desktop (sem touch/UA Android) no conjunto desktop. Não precisa alterar a configuração dos projetos.

```powershell
$env:CI = '1'
$env:PLAY_SCREENSHOTS = '1'
$env:NODE_OPTIONS = '--max-old-space-size=6144'
Remove-Item Env:STAGING_ORIGIN -ErrorAction SilentlyContinue
npm run -w web test:e2e -- tests/e2e/play-screenshots.spec.ts --project=mobile --workers=1 --grep 'phone'
if ($LASTEXITCODE -ne 0) { throw 'Falha na captura de telefone' }
npm run -w web test:e2e -- tests/e2e/play-screenshots.spec.ts --project=mobile --workers=1 --grep 'tablet-7'
if ($LASTEXITCODE -ne 0) { throw 'Falha na captura de tablet de 7 polegadas' }
npm run -w web test:e2e -- tests/e2e/play-screenshots.spec.ts --project=mobile --workers=1 --grep 'tablet-10'
if ($LASTEXITCODE -ne 0) { throw 'Falha na captura de tablet de 10 polegadas' }
npm run -w web test:e2e -- tests/e2e/play-screenshots.spec.ts --project=mobile --workers=1 --grep 'desktop'
if ($LASTEXITCODE -ne 0) { throw 'Falha na captura de desktop' }
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
App não oficial Auri: EQ e USB testados no Galaxy A70, sem validação plena.
```

### Full description

```text
Aviso: testamos a gravação num Kuba Auri com Galaxy A70 (Android 11), não em outros fabricantes. Prévia, gravação e restauração do Padrão Auri confirmadas pelo som; bytes na ponte nativa iguais aos do site no computador. Validação completa pendente. Som estranho? Grave Neutro; se não resolver, pelo site no computador (Chrome ou Edge). Relate: https://github.com/marco-jardim/open-auri/issues/new?template=android-cable-report.yml

Conecte o cabo Kuba Auri por USB-C/OTG e grave curvas de equalização pela camada USB nativa do Android, que o navegador do celular não oferece. O transporte USB nativo permite selecionar o cabo e pedir permissão ao Android. O teste acústico e a comparação de bytes na ponte nativa se limitam ao Galaxy A70; faltam outro fabricante e paridade USB no fio. A gravação depende de uma ação sua e do checklist, nunca é automática. Há também Diagnóstico USB e exportação de arquivos pelo seletor do sistema.

Projeto independente: open-auri não é oficial nem endossado pela Kuba e não tem afiliação com ela ou qualquer fabricante. Crie, explore e compare curvas de equalização. Acesse a biblioteca de curvas e presets, compare respostas e participe da comunidade.

Não há leitura de volta do cabo. A vida útil da memória flash é desconhecida.

Código aberto sob AGPL-3.0, com código-fonte e contribuições em:
https://github.com/marco-jardim/open-auri

O protocolo foi estudado para fins de interoperabilidade. Use por sua conta e risco: não nos responsabilizamos por danos ao cabo, ao fone ou à sua audição.

Requisitos: Android 8 ou mais recente, aparelho com USB host/OTG, cabo compatível e Android System WebView atualizado. É necessária conexão com a internet para carregar o conteúdo e usar os recursos online. Destinado a pessoas com 18 anos ou mais.

Para relatar resultados, use o link do aviso inicial. Informe o aparelho, as versões do Android e do app e o JSON do Diagnóstico USB. Não inclua dados pessoais no relato.

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
Unofficial Auri EQ app: USB tested on Galaxy A70, not fully validated.
```

### Full description

```text
Notice: writing tested on a Kuba Auri with Galaxy A70 (Android 11), not other manufacturers. Preview, writing and Padrão Auri restoration confirmed acoustically; native bridge bytes match the desktop site. Full validation pending. Sound off? Write Neutral; if unresolved, use the desktop site (Chrome or Edge). Report: https://github.com/marco-jardim/open-auri/issues/new?template=android-cable-report.yml

Connect the Kuba Auri cable through USB-C/OTG and write EQ curves through Android's native USB layer, which the phone browser does not provide. The native USB transport lets you select the cable and request Android permission. Acoustic testing and native bridge byte comparisons are limited to the Galaxy A70; another manufacturer and on-wire USB parity are still pending. Writing requires your action and the checklist, and is never automatic. USB Diagnostics and file exports through the system picker are also available.

Independent project: open-auri is not official or endorsed by Kuba and is not affiliated with Kuba or any manufacturer. Create, explore and compare EQ curves. Browse the curve and preset library, compare responses and take part in the community.

There is no readback from the cable. The lifespan of its flash memory is unknown.

Open source under AGPL-3.0, with source code and contributions at:
https://github.com/marco-jardim/open-auri

The protocol was studied for interoperability. Use at your own risk: we are not responsible for damage to the cable, headphones or your hearing.

Requirements: Android 8 or newer, a device with USB host/OTG, a compatible cable and an up-to-date Android System WebView. An internet connection is needed to load content and use online features. Intended for people aged 18 or over.

To report results, use the link in the opening notice. Include your device, Android and app versions, and the USB Diagnostics JSON. Do not include personal data in the report.

See the Data safety section of this listing and the privacy policy for collected and shared data, purposes and deletion options. The audio file used for previews stays on your device.

Website: https://open-auri.com
Privacy policy: https://open-auri.com/privacidade
```
