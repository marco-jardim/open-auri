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

São 7 capturas por idioma (`pt-BR` e `en-US`): editor, Cabo sem conexão, Comparar, Soe como X, Comunidade, Teste cego e Cabo com USB nativo conectado. Com ícone e feature graphic, o conjunto mantém 16 PNGs. `3-comparar` deve mostrar o botão Como funciona / How it works sem sobrepor o texto acima do título. `7-native-connect` deve mostrar o painel USB Android e o estado Conectado / Connected, mantendo o aviso de gravação ainda não testada visível, não o diálogo de confirmações. O dispositivo dessa captura é falso, ligado pelo bridge Capacitor real; a imagem não comprova conexão ou gravação em hardware real.

Regenerar a partir da raiz do repositório, em PowerShell, sem `STAGING_ORIGIN` definido:

```powershell
$env:CI = '1'
$env:PLAY_SCREENSHOTS = '1'
$env:NODE_OPTIONS = '--max-old-space-size=6144'
npm run -w web test:e2e -- tests/e2e/play-screenshots.spec.ts --project=mobile --workers=1
if ($LASTEXITCODE -ne 0) { throw 'Falha na captura Playwright' }
npm run play:assets
if ($LASTEXITCODE -ne 0) { throw 'Falha na normalização das artes' }
npm run test:tools
```

O primeiro comando npm captura as telas em `docs/android/play-assets/screenshots/<locale>/`; `play:assets` renderiza ícone/feature graphic e normaliza as capturas existentes, não abre o app para recapturá-las. Aprovar visualmente os dois idiomas após a execução. Para o fluxo do revisor e os caminhos exatos de denúncia/ocultação, usar [play-conteudo.md](./play-conteudo.md#2-acesso-ao-app); a captura USB simulada não substitui a conta de revisão nem o vídeo obrigatório.

## pt-BR

### Title

```text
open-auri
```

### Short description

```text
App não oficial para o cabo Auri, com equalização e USB nativo em teste.
```

### Full description

```text
Aviso: a gravação pelo app ainda não foi testada num cabo Auri real. O app usa o mesmo protocolo e envia os mesmos bytes que o site no computador (conferido por testes automáticos); em teoria o resultado é o mesmo, mas não há garantia. Relate o resultado em https://github.com/marco-jardim/open-auri/issues/new?template=android-cable-report.yml

Conecte o cabo Kuba Auri por USB-C/OTG e grave curvas de equalização pela camada USB nativa do Android, que o navegador do celular não oferece. O transporte USB nativo permite selecionar o cabo e pedir permissão ao Android. O protocolo e os bytes enviados são os mesmos da versão para computador; o caminho físico USB do app ainda não foi validado. A gravação depende de uma ação sua e do checklist, nunca é automática. Há também Diagnóstico USB e exportação de arquivos pelo seletor do sistema.

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
Unofficial Auri cable app with EQ curves and native USB under testing.
```

### Full description

```text
Notice: writing from the app has not been tested on a real Auri cable yet. The app uses the same protocol and sends the same bytes as the desktop site (checked by automated tests); in theory the result is the same, but it is not guaranteed. Report your result at https://github.com/marco-jardim/open-auri/issues/new?template=android-cable-report.yml

Connect the Kuba Auri cable through USB-C/OTG and write EQ curves through Android's native USB layer, which the phone browser does not provide. The native USB transport lets you select the cable and request Android permission. The protocol and transmitted bytes are the same as the computer version; the app's physical USB path has not been validated yet. Writing requires your action and the checklist, and is never automatic. USB Diagnostics and file exports through the system picker are also available.

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
