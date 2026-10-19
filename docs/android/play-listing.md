# Ficha da loja Android (P2)

Textos para copiar no Play Console. Os identificadores dos três campos seguem em inglês nos dois idiomas. Copie somente o conteúdo dos blocos, sem as cercas. Os limites e avisos são conferidos por `test/tools/play-listing.test.mjs`, com base em `play-requisitos.md` e no Anexo G.5 do plano Android.

## Campos compartilhados

- Categoria: Music & Audio / Música e áudio
- Tags sugeridas: equalização, áudio, ferramentas de áudio
- E-mail de contato: contato público do desenvolvedor (definido no Play Console)
- Site: https://open-auri.com
- Política de privacidade: https://open-auri.com/privacidade

O contato é um placeholder para preenchimento no Console, não um endereço a publicar neste arquivo. Confirme as tags disponíveis no Console antes do envio.

## pt-BR

### Title

```text
open-auri
```

### Short description

```text
Curvas de equalização para o cabo Auri, com integração USB nativa em teste.
```

### Full description

```text
Aviso: a gravação pelo app ainda não foi testada num cabo Auri real. O app usa o mesmo protocolo e envia os mesmos bytes que o site no computador (conferido por testes automáticos); em teoria o resultado é o mesmo, mas não há garantia. Relate o resultado em https://github.com/marco-jardim/open-auri/issues/new?template=android-cable-report.yml

open-auri reúne ferramentas para criar, explorar e comparar curvas de equalização para o cabo Kuba Auri. Acesse a biblioteca de curvas e presets, compare respostas e participe da comunidade do site.

Além das páginas do site, o app inclui um transporte USB nativo para selecionar o cabo conectado por USB-C/OTG, pedir permissão ao Android e tentar gravar a curva. Essa integração com o hardware não está disponível no navegador móvel. O protocolo e os bytes enviados são os mesmos do site no computador; o caminho físico USB do app ainda não foi validado. A gravação depende de uma ação sua e do checklist, nunca é automática. Há também Diagnóstico USB e exportação de arquivos pelo seletor do sistema.

Não há leitura de volta do cabo. A vida útil da memória flash é desconhecida.

Código aberto sob AGPL-3.0, com código-fonte e contribuições em:
https://github.com/marco-jardim/open-auri

open-auri não é oficial nem endossado pela Kuba ou por qualquer fabricante. O protocolo foi estudado para fins de interoperabilidade. Use por sua conta e risco: não nos responsabilizamos por danos ao cabo, ao fone ou à sua audição.

Requisitos: Android 8 ou mais recente, aparelho com USB host/OTG, cabo compatível e Android System WebView atualizado. É necessária conexão com a internet para acessar o site.

Para relatar resultados, use o link do aviso inicial. Informe o aparelho, as versões do Android e do app e o JSON do Diagnóstico USB. Não inclua dados pessoais no relato.

O app não coleta dados além dos já coletados pelo próprio site. Consulte a política de privacidade para conhecer o tratamento de dados do site.

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
EQ curves for the Auri cable, with native USB integration under testing.
```

### Full description

```text
Notice: writing from the app has not been tested on a real Auri cable yet. The app uses the same protocol and sends the same bytes as the desktop site (checked by automated tests); in theory the result is the same, but it is not guaranteed. Report your result at https://github.com/marco-jardim/open-auri/issues/new?template=android-cable-report.yml

open-auri brings together tools to create, explore and compare EQ curves for the Kuba Auri cable. Browse the curve and preset library, compare responses and take part in the site's community.

Beyond the site's pages, the app includes a native USB transport to select a cable connected through USB-C/OTG, request Android permission and attempt to write a curve. This hardware integration is not available in the mobile browser. The protocol and transmitted bytes are the same as the desktop site; the app's physical USB path has not been validated yet. Writing requires your action and the checklist, and is never automatic. USB Diagnostics and file exports through the system picker are also available.

There is no readback from the cable. The lifespan of its flash memory is unknown.

Open source under AGPL-3.0, with source code and contributions at:
https://github.com/marco-jardim/open-auri

open-auri is not official or endorsed by Kuba or any manufacturer. The protocol was studied for interoperability. Use at your own risk: we are not responsible for damage to the cable, headphones or your hearing.

Requirements: Android 8 or newer, a device with USB host/OTG, a compatible cable and an up-to-date Android System WebView. An internet connection is needed to access the site.

To report results, use the link in the opening notice. Include your device, Android and app versions, and the USB Diagnostics JSON. Do not include personal data in the report.

The app collects no data beyond what the website itself already collects. See the privacy policy for details of the site's data processing.

Website: https://open-auri.com
Privacy policy: https://open-auri.com/privacidade
```
