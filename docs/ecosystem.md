# Ecossistema e implementações de referência

O mesmo chipset (VID `0x3302`) tem um **wire format irmão**, o `0x4B`, que é
**bem documentado** em projetos abertos. O nosso `0xCB` não; as fontes dele são
a página do kuba e o app oficial WalkPlay ([abaixo](#app-oficial-walkplay-0xcb)).
Este documento registra os dois e o que dá para reusar de cada um.

## `0x4B` × `0xCB`: comparação

| | **`0x4B`** (padrão documentado) | **`0xCB`** (o do cabo analisado) |
|---|---|---|
| Report ID | `0x4B` | `0xCB` (= `0x4B \| 0x80`) |
| Tamanho do relatório | 64 bytes | 31 bytes |
| Header | por-comando (com campo de comprimento) | `"EQ1#"` + comprimento u16 + geometria do bloco 🟡 |
| Fatiamento | **1 pacote por banda** | **bloco de 10 bandas** em 9 pacotes |
| Escala dos coeficientes | **Q30** (`2^30`) ⇒ \|coef\| < 2 | **Q27** (`2^27`) ⇒ \|coef\| < 16 |
| Ordem dos coeficientes | `[b0, b1, b2, -a1, -a2]` | `[b0, b2, -a1, b1, -a2]` |
| Byte de tipo de filtro | **sim** (`LSQ=1, PK=2, HSQ=3, LP=4, HP=5`), mais `f`, `Q` e ganho no pacote | **não**, só coeficientes |
| CRC | não | **CRC16-CCITT** |
| Leitura (*read*) | documentada (`0x80`) | **só a tag de EQ**: `80 00 00 00 FF` ⇒ `80 <tag>` (app oficial; `0x65` no Auri). Curva e versão: não suportadas |
| Gravação só na RAM | `TEMP_WRITE` (`0x0A`) | dados sem comando final já aplicam (B12); o app oficial tem `01 <tag> 00 00 FF` (aplicar sem salvar) |
| Commit | `TEMP_WRITE` → `FLASH_EQ` (slot `101` no frost-tune); o eqloader envia antes `0x05` e `0x17`, não documentados | `01 <tag> 00 01 FF`; `[01 65 00 01 FF]` com a tag do Auri (contém `0x65 = 101`) |
| `FS` de projeto | 96 kHz (eqloader, frost-tune) | 96 kHz (kuba; medido na B10) |
| **Confiança** | ✅ (código aberto) | ✅ (formato, cabo real e app oficial) |

Consequência de projeto: um `core` agnóstico + **camada de protocolo plugável**
com duas implementações (`0xCB`, `0x4B`), porque **não sabemos** qual o cabo usa
até plugá-lo. As duas coincidências na tabela (report ID e slot `101`) sugerem
um SDK comum; o cabo pode expor **os dois** reports (sonda B1).

**Faixa dos coeficientes.** Em Q30 nenhum coeficiente chega a 2: reforços
grandes em frequências altas não cabem, e as ferramentas `0x4B` fazem *clamp*
silencioso (`clamp_i32` no frost-tune), de modo que o filtro gravado deixa de ser o
projetado. O Q27 do `0xCB` dá 8× mais margem.

**Projeto dos coeficientes no `0x4B`.** O `eqloader` comenta que calcula
*"always a peaking design, whatever the band's type, matching the vendor tool"*.
Como o pacote também leva `f`, `Q`, ganho e tipo, é provável que o firmware
`0x4B` recalcule os coeficientes a partir dos parâmetros. No `0xCB` isso é
impossível: só os coeficientes viajam.

## Comandos do `0x4B` (referência)

Do `frost-tune` (`walkplay_protocol.rs`) e do `eqloader.py`:

| Comando | Valor |
|---|---|
| `WRITE` / `READ` | `0x01` / `0x80` |
| `END` | `0x00` |
| `FLASH_EQ` | `0x01` |
| `GLOBAL_GAIN` | `0x03` |
| `PEQ_VALUES` | `0x09` |
| `TEMP_WRITE` | `0x0A` |
| `VERSION` | `0x0C` |
| `FILTER_SLOT` | `101` |

Leitura de banda: `[0x80, 0x09, nonce, 0x00, index, 0x00]` ⇒ permite **pull /
verify / rollback**. O `0xCB` não tem equivalente: o app oficial só lê a tag de
EQ e marca a leitura de filtros como não suportada pelo chip.

## App oficial WalkPlay (`0xCB`)

O app web oficial de PEQ ([`peq.szwalkplay.com`](https://peq.szwalkplay.com/);
espelho offline [`Ircama/walkplay`](https://github.com/Ircama/walkplay), arquivo
`public/assets/index-BEOfvcHi.js`) tem uma classe de dispositivo com grupo
`"CB"` e log `"CB1100AU"` que fala o `0xCB`: mesmo frame `"EQ1#"`, Q27/Q23,
CRC-16/CCITT-FALSE e 9 pacotes. Diferenças em relação à página do kuba: envia só
os filtros ativos (`n` variável), tem um comando de aplicar sem salvar e lê a
tag de EQ. Essa classe fica fora do caminho principal do app, que cria a classe
genérica `"CB"` pelo report `0x4B` (que o Auri não expõe). Detalhes:
[`protocol-0xcb.md`](protocol-0xcb.md#confirmação-pelo-app-oficial-walkplay).

O chip é anunciado pela TTGK como o bridge **CB5100** com *"支持WALK PLAY APP
EQ联动"* (brief
[`TT39510B01`](https://szttgk.com/uploads/files/20240725/51fad44bb79a05a35046af38b0017de5.pdf),
página do [CB5100PRO](https://szttgk.com/en/product/HIFIhighfidelityaudiomodule/815.html));
se o Auri usa exatamente esse chip ou uma variante "CB1100AU" não está
confirmado. O VID `0x3302` é compartilhado por aparelhos com módulos TTGK
(Moondrop e outros; [the-sz.com](https://the-sz.com/products/usbid/index.php?v=0x3302));
o protocolo irmão documentado nos projetos abertos é o `0x4B`, com report e
framing diferentes.

Ganho global: o `0x4B` grava **dB inteiro** num registrador, e alguns aparelhos
têm um **buffer de hardware** (ex.: `-5 dB` no CrinEar Protocol Micro) somado a ele.

## Servidor de firmware da WalkPlay

Extraído do app oficial em 2026-10-28 (endereço e chave estavam ofuscados no
bundle; abaixo, já decodificados). Responde sem login.

- **Base:** `https://walkplay-api.szwalkplay.com`
- **Cabeçalhos:** `Content-Type: application/json`, `client: PC`,
  `domain: peq.szwalkplay.com`
- **Corpo:** `pid` e `vid` em hexa com prefixo `0x` (ex.: `"0x8902"`,
  `"0x3302"`); sem o prefixo, o servidor responde "信息不存在" (não existe).
- **Resposta:** string Base64 cujos bytes passam por XOR com a chave ASCII
  `d2Fsa3BsYXlAMjAyNS4uLw==` (os 24 caracteres, repetidos); o resultado é JSON.

| Rota (POST) | Corpo | Retorno |
|---|---|---|
| `/api/v3-1/common/checkFirmwareVersion` | `{"pid":"0x43CC","vid":"0x3302","version":"0.0"}` | firmware mais recente (`data.url`, `name`, `deviceType`, `schemeNo`, `version`) ou "已经是最新版本" (já é a mais recente) |
| `/api/v3-1/common/getFirmwareInfoListByPidAndVid` | `{"pid":"0x43CC","vid":"0x3302"}` | lista (vazia para todos os PIDs testados) |

Exemplo em PowerShell:

```powershell
$key = [Text.Encoding]::UTF8.GetBytes('d2Fsa3BsYXlAMjAyNS4uLw==')
$r = Invoke-WebRequest -Method Post -ContentType 'application/json' `
  -Uri 'https://walkplay-api.szwalkplay.com/api/v3-1/common/checkFirmwareVersion' `
  -Headers @{ client = 'PC'; domain = 'peq.szwalkplay.com' } `
  -Body '{"pid":"0x43CC","vid":"0x3302","version":"0.0"}'
$raw = [Convert]::FromBase64String($r.Content.Trim('"'))
[Text.Encoding]::UTF8.GetString([byte[]](0..($raw.Length - 1) | % { $raw[$_] -bxor $key[$_ % $key.Length] }))
```

**Kuba Auri (`0x3302:0x8902`):** o PID existe no cadastro (a lista responde
sucesso e a checagem "já é a mais recente"), mas **não há firmware publicado**.

### Firmwares publicados (VID `0x3302`, consultados em 2026-10-28)

Links diretos de download (GET, sem login). Só para análise: **gravar firmware
de outro aparelho no cabo pode inutilizá-lo**.

| PID | Chip | Nome | Esquema (`schemeNo`) | Versão | Download |
|---|---|---|---|---|---|
| `0x43CC` | CB5100 | `CB5100_PID43CC_V1.4_251219` | 16 (10 filtros no app) | 1.4 | <https://walkplay-api.szwalkplay.com/api/common/download/202602021611340fb8190cd6499b42f9.bin> |
| `0x43CD` | CB5100 | `CB5100_PID43CD_V0.4_260228` | 16 | 0.4 | <https://walkplay-api.szwalkplay.com/api/common/download/20260228154932c11768a31e9000f5f9.bin> |
| `0xC20F` | CB1200 | `CB1200_C20F_V0.2_260709` | 11 | 0.2 | <https://walkplay-api.szwalkplay.com/api/common/download/202607091523497e0b255de074326bb6.bin> |
| `0x1233` | CB1200 | `CB1200_1233_V0.2_260920_LRFIX_EQFIX` | 11 | 0.2 | <https://walkplay-api.szwalkplay.com/api/common/download/20260920151619ba5e7009eedffe9e1a.bin> |
| `0x1237` | CB1200 | `CB1200_0x1237_v0.5_uac12` | 11 | 0.5 | <https://walkplay-api.szwalkplay.com/api/common/download/202610141046545aa0863bc02a3f7ef3.bin> |
| `0x123F` | CB1200 | `CB1200_0x123F_V0.7` | 11 | 0.7 | <https://walkplay-api.szwalkplay.com/api/common/download/202610131606034db6691ed26a976e65.bin> |

A varredura cobriu os PIDs `0x1200–0x12FF`, `0x2900–0x29FF`, `0x33C0–0x33CF`,
`0x4300–0x43FF`, `0x8900–0x89FF` e `0xC200–0xC2FF`; a tabela pode crescer.

## Implementações abertas

| Projeto | O que é | Protocolo | Licença |
|---|---|---|---|
| [`devilAPI/walkplay-eqloader`](https://github.com/devilAPI/walkplay-eqloader) | App Flutter (web no GitHub Pages + desktop/Android) e `eqloader.py` (branch `legacy-tkinter`). Editor, push/pull, AutoEQ, formato `.txt`. | `0x4B` | **sem arquivo de licença** ⇒ tratar como todos os direitos reservados |
| [`Bukutsu/frost-tune`](https://github.com/Bukutsu/frost-tune) | Rust; `walkplay_protocol.rs` com pull/verify/rollback. | `0x4B` | MIT (SPDX no header do arquivo) |
| [`Bukutsu/glacier-eq`](https://github.com/Bukutsu/glacier-eq) | App Tauri; tem **dummy DAC** para desenvolvimento. | `0x4B` | não verificado |
| [`jeromeof/devicePEQ`](https://github.com/jeromeof/devicePEQ) | Plugin JS WebHID multi-marca (`walkplayJS/`). | `0x4B` | possui `LICENSE.txt` (conteúdo não verificado) |
| [`mandy321/Audiocular-Aura`](https://github.com/mandy321/Audiocular-Aura) | Web app WebHID; `dist/assets/index.js` traz implementação multi-protocolo + tabela de VID/PID. | `0x4B` (+ outros) | não verificado |
| [`Chronosauros/contour`](https://github.com/Chronosauros/contour) | Implementação aberta do `0x4B`. | `0x4B` | não verificado |
| [`Ircama/walkplay`](https://github.com/Ircama/walkplay) | Espelho offline do app oficial WalkPlay PEQ (`peq.szwalkplay.com`); inclui a classe `"CB1100AU"`. | `0xCB` (só essa classe foi analisada) | não verificado |
| [`cheesyserg/pyBlackPearl`](https://github.com/cheesyserg/pyBlackPearl) | Scripts de query (TRN Black Pearl). | `0x4B` | não verificado |
| [`eq.hangout.audio`](https://eq.hangout.audio) (Crinacle's EQ Tool) | **Só a matemática** (`shared/equalizer.js`): biquads RBJ, otimizador AutoEQ, graphic EQ. `DefaultSampleRate = 48000`. | nenhum | site proprietário |

> **Licença é bloqueador.** Antes de copiar código: `eqloader` **não tem licença**
> e o `equalizer.js` é de um site proprietário. Algoritmos e fórmulas (RBJ,
> AutoEQ) não são protegidos por direito autoral; **implementações** são. O
> próprio `equalizer.js` declara que tirou os biquads do
> [`AutoEq`](https://github.com/jaakkopasanen/AutoEq), que é **MIT** (verificado
> em 2026-10-15), e é de onde o codec do `open-auri` porta o projeto de PK, LS e
> HS, com o aviso em [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md). A
> fórmula de magnitude do AutoEq não foi portada: é 35× menos precisa em baixa
> frequência ([`protocol-0xcb.md`](protocol-0xcb.md#design-dos-biquads-rbj)). O
> `open-auri` é AGPL-3.0.

## Matemática reusável (sem protocolo)

O `shared/equalizer.js` do hangout.audio e o `eqloader.py` implementam o
*mesmo* motor, e são a referência para:

- biquads RBJ (peak, low-shelf, high-shelf, low-pass, high-pass);
- resposta somada (`calc_gains`) para desenhar curvas;
- **AutoEQ** (`search_candidates` + otimizador `strip`/`optimize`), com
  `AutoEQRange = [20, 15000]`, `OptimizeQRange = [0.5, 2]`, `OptimizeGainRange = [-12, 12]`;
- **normalização de loudness ISO 226:2003** (port do CrinGraph), para alinhar
  medição e alvo antes de otimizar;
- cômputo de **preamp seguro** (`calc_preamp`), com `min(0, ...)` para nunca adicionar ganho.

Útil porque, para o `0xCB`, só o *cálculo* roda aqui; o chip recebe biquads crus.

## Formato de arquivo de perfil

`EqualizerAPO` / `eq.hangout.audio` (`.txt`), usado pelo `eqloader`:

```
Preamp: -6.0 dB
Filter 1: ON PK Fc 1000.0 Hz Gain 3.5 dB Q 1.000
Filter 2: ON LS Fc 80.0 Hz Gain -2.0 dB Q 0.707
```

Tipos: `PK`, `LS`/`LSC`/`LSQ`, `HS`/`HSC`/`HSQ`, `LP`, `HP`.
Bom candidato a formato de import/export por ser interoperável.

O codec só aceita `PK`, `LS`, `HS`, `LP`, `HP` e `OFF`, e recusa qualquer outro
nome. Um importador precisa mapear `LSC`/`LSQ` → `LS` e `HSC`/`HSQ` → `HS`
explicitamente. Antes, o codec transformava silenciosamente um shelf
desconhecido em peaking.
