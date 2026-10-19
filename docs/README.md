# Documentação: open-auri

Notas de engenharia reversa do firmware **`0xCB`** da família de chips **CB5100**
(bridge USB de áudio do ecossistema *Walkplay*, atribuído à Savitech).

Todo o conteúdo aqui é rastreável a uma fonte primária: código que funciona,
código aberto de terceiros, ou um documento de fabricante. O que não tem fonte
está marcado como hipótese ou pendência, não como fato.

## Legenda de confiança

| Marca | Significado |
|---|---|
| ✅ **Confirmado** | Verificado em código-fonte que funciona, ou em fonte primária citada (link). |
| 🟡 **Hipótese** | Inferência plausível a partir do formato, ainda **não** verificada em hardware. |
| ❌ **Pendente** | Só fecha com o cabo físico (captura HID) ou com informação do produto. |

> ⚠️ **Contexto de verificação.** Até a data desta nota **não havia cabo disponível**.
> Portanto *nada* no caminho de dispositivo foi validado em hardware. O que é ✅ é
> a reconstrução do formato a partir de uma implementação que grava na flash
> (a página `equalizador.kuba.audio`), não a confirmação de que o nosso código
> conversa com o chip.

## Índice

| Documento | Conteúdo |
|---|---|
| [`hardware.md`](hardware.md) | Fabricante do chip, VID/PID, módulos da TTGK, FCC, datasheets. |
| [`protocol-0xcb.md`](protocol-0xcb.md) | O wire format `0xCB` reconstruído byte a byte. |
| [`ecosystem.md`](ecosystem.md) | Implementações abertas de referência e o formato `0x4B` (irmão). |
| [`verification.md`](verification.md) | Testes (`npm test`): equivalência, verificações independentes e validação. |
| [`ideas.md`](ideas.md) | Usos previstos, excêntricos e não previstos abertos pelo protocolo. |
| [`social.md`](social.md) | Camada social: formato compacto, proveniência, versionamento, hospedagem. |
| [`probing.md`](probing.md) | Plano técnico: sondagem do firmware, testes cegos, otimizações de qualidade. |
| [`open-questions.md`](open-questions.md) | O que está confirmado, o que é hipótese, o que falta, e a errata. |

## Produto web e operação

| Documento | Conteúdo |
|---|---|
| [`../README.md`](../README.md) | O que é o open-auri, segurança, desenvolvimento local, testes e licença. |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | Fluxo de contribuição, commits, testes, i18n, regras de texto e de dados. |
| [`api.md`](api.md) | Contrato da API v1, códigos de erro, cache e visibilidade. |
| [`social.md`](social.md) | Modelo social: publicação, versões, compartilhamentos, rankings e moderação. |
| [`deploy.md`](deploy.md) | CI/CD e deploy de staging e produção. |
| [`seguranca.md`](seguranca.md) | Cabeçalhos, CSP, modelo de ameaças e revisão de dependências. |
| [`operacao.md`](operacao.md) | Índice da operação: observabilidade, backups, capacidade e runbooks. |
| [`lgpd.md`](lgpd.md) | Registro das operações de tratamento (LGPD, art. 37). |

## Índice do núcleo

A entrada [`src/index.mjs`](../src/index.mjs), importada como `open-auri`, oferece os
namespaces `dsp`, `safety`, `share`, `io`, `solver`, `catalog`, `transport`, `policy` e
`meter`, além dos atalhos mais usados. Cada área também tem uma entrada própria:

```js
import { encodePayload, gateForWrite, encodeS1, NEUTRO } from 'open-auri';
import { autoPreamp } from 'open-auri/safety';
```

### DSP: `open-auri/dsp`

- [`eq0xcb.mjs`](../src/dsp/eq0xcb.mjs): filtros, quantização Q27, payloads e reports HID.
- [`grid.mjs`](../src/dsp/grid.mjs): grade logarítmica comum de frequências.
- [`level.mjs`](../src/dsp/level.mjs): resposta e nível médio dos coeficientes quantizados.
- [`distance.mjs`](../src/dsp/distance.mjs): comparação perceptual entre curvas, com ajuste de nível.
- [`iso226.mjs`](../src/dsp/iso226.mjs): contornos de igual sonoridade e pesos perceptuais ISO 226.

### Segurança: `open-auri/safety`

- [`gate.mjs`](../src/safety/gate.mjs): análise de estabilidade, headroom e pré-amp
  dentro do envelope observado para gravação, sem constituir prova de segurança.
  Exporta também `gateProfile`, `isWaivable`, `YOLO_WAIVABLE`, `HARD_REASONS`,
  `CODEC_PREAMP_FLOOR_DB`, `YOLO_STORAGE_PREAMP_FLOOR_DB` e `YOLO_PREAMP_MAX_DB` para
  seleção e consulta dos perfis do gate. Acima de 20 kHz só passam seções que não amplificam
  (`d7:boost-above-20k`, dispensável no perfil YOLO). Quando o veredito YOLO depende de
  alguma dispensa (qualquer código dispensável, `g:preamp` incluído), valem também
  `d:prefix-peak-full` e as checagens estendidas de 20 Hz a 48 kHz (`d:prefix-peak-extended`
  e `e:output-extended`), com ou sem seção acima de 20 kHz: um reforço que precisa de
  dispensa enfrenta os mesmos limites em 20000 Hz e em 20001 Hz. Sem dispensa, a curva é
  julgada exatamente como no perfil padrão, então o YOLO nunca é mais restrito que ele.
  No perfil YOLO, `autoPreamp` busca a partir de 0 dB (`YOLO_PREAMP_MAX_DB`), e
  `autoPreamp(bands, {profile: 'yolo', storable: true})` não desce abaixo de −25,5 dB.
- [`classify.mjs`](../src/safety/classify.mjs): `classifyCurve`, a classe de uma curva
  para armazenar e publicar (`standard`, `yolo` ou `rejected`, com os códigos dispensados
  ou os que bloqueiam), e `classifierVersionInput`, o JSON estável de `THRESHOLDS`,
  `YOLO_THRESHOLDS` e dos códigos dispensáveis na classificação, para a versão do
  classificador. O núcleo interno fica em `classify-core.mjs`, fora do índice.
- [`policy.mjs`](../src/safety/policy.mjs): limites de edição, grade, interpolação e busca de fronteira,
  além de `AUDIBLE_MAX_HZ`, `ULTRA_MAX_HZ`, `ULTRA_CUT_Q_MAX`, `isUltrasonic` e `freqMaxFor`
  (frequência máxima por camada: 20 kHz em Ouvir e Ajustar; em Engenharia, 32 kHz para
  seções que não amplificam e, no Modo YOLO, para todas).
- [`thresholds.mjs`](../src/safety/thresholds.mjs): limiares de segurança e sua proveniência.

Os aliases `levelDb`, `MEAN_FREQUENCIES` e `sectionDb` vêm de `dsp/level.mjs`;
`THRESHOLDS`, `PROVENANCE` e `YOLO_THRESHOLDS` vêm de `safety/thresholds.mjs`.
Embora o gate também os reexporte, cada nome aparece uma única vez no índice da área.

### Compartilhamento: `open-auri/share`

- [`s1.mjs`](../src/share/s1.mjs): codec compacto S1, chave canônica e identificador da curva.
- [`envelope.mjs`](../src/share/envelope.mjs): normalização, validação e JSON dos envelopes de presets.

### Entrada e saída: `open-auri/io`

- [`equalizer-apo.mjs`](../src/io/equalizer-apo.mjs): importação e exportação de curvas Equalizer APO.
- [`measurement.mjs`](../src/io/measurement.mjs): leitura de medições, reamostragem,
  normalização e suavização.

### Ajuste paramétrico: `open-auri/solver`

- [`peq.mjs`](../src/solver/peq.mjs): ajuste limitado de filtros PEQ e construção de curvas-alvo.

### Catálogo: `open-auri/catalog`

- [`presets.mjs`](../src/catalog/presets.mjs): presets oficiais imutáveis, Neutro e
  consultas por ID ou grupo.

### Transporte: `open-auri/transport`

- [`webhid.mjs`](../src/transport/webhid.mjs): seleção do cabo e gravação com gate, espaçamento e commit.
- [`fake-device.mjs`](../src/transport/fake-device.mjs): dispositivo, conexão HID e relógio simulados.

### Políticas locais: `open-auri/policy`

- [`flash.mjs`](../src/policy/flash.mjs): intervalo entre gravações, contadores e avisos de uso da flash.
- [`loudness.mjs`](../src/policy/loudness.mjs): aviso de salto de nível entre curvas.
- [`journal.mjs`](../src/policy/journal.mjs): validação, limite de entradas e JSON do diário local.
  Exporta `JOURNAL_WAIVED_MAX`, o limite de códigos dispensados por entrada YOLO,
  também pelo índice da área.

### Medição de áudio: `open-auri/meter`

- [`ballistics.mjs`](../src/meter/ballistics.mjs): medidores VU e PPM com balística temporal.
- [`truepeak.mjs`](../src/meter/truepeak.mjs): pico verdadeiro por sobreamostragem.
- [`loudness.mjs`](../src/meter/loudness.mjs): ponderação K e sonoridade momentânea e de curto prazo.
- [`correlation.mjs`](../src/meter/correlation.mjs): correlação entre canais estéreo.
- [`common.mjs`](../src/meter/common.mjs): constantes e auxiliares públicos dos medidores.

### Formatos de referência

- [`schemas/preset-envelope-1.schema.json`](../schemas/preset-envelope-1.schema.json):
  esquema JSON do envelope v1, validado pela API `open-auri/share`.
- [`schemas/preset-envelope-2.schema.json`](../schemas/preset-envelope-2.schema.json):
  esquema JSON do envelope v2 (v1 mais rótulos de filtro opcionais), emitido só quando a
  curva tem rótulos.
- [`docs/s1-format.md`](s1-format.md): especificação congelada do S1 v1, implementado em
  `open-auri/share`.

## Créditos

- **Presets e implementação de referência:** [Kuba](https://equalizador.kuba.audio/)
  (`kuba.audio`). A própria página credita a curva padrão a **Leonardo**
  ("Padrão = filtros do Leonardo"). Os bytes de referência em
  `test/fixtures/` derivam dessa implementação (ver
  [`verification.md`](verification.md)). O codec implementa o layout de bytes
  aprendido dessa referência, sem código nem nomes dela.
- **Projeto dos filtros PK/LS/HS:** porte do [AutoEq](https://github.com/jaakkopasanen/AutoEq)
  (MIT, Jaakko Pasanen); ver [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).
- **Fórmulas dos filtros:** Robert Bristow-Johnson, *Audio EQ Cookbook*.

## Resumo executivo

- O chip que hospeda o DSP/PEQ é o **CB5100**, integrado em módulos pela
  **Shenzhen TTGK Technology** (dona do app *WalkPlay*). ✅ O fabricante é
  atribuído à **Savitech** por uma única fonte secundária. 🟡
- O cabo analisado enumera como VID `0x3302` / PID `0x8902` ("USB DSP Audio"). ✅
- Existem **dois wire formats** na mesma família de VID:
  - **`0x4B`:** padrão documentado em vários projetos abertos (Q30, byte de tipo de filtro, leitura). ✅
  - **`0xCB`:** o do cabo analisado ("EQ1#", Q27, CRC16, bloco de 10 bandas, leitura desconhecida). ✅ (formato) / ❌ (device)
  - Os dois parecem vir do mesmo SDK (`0xCB = 0x4B | 0x80`; slot `101` nos dois). 🟡
- Entre os projetos abertos pesquisados, nenhum descreve o `0xCB`; a única fonte é
  a própria página do kuba. ✅
- O codec reproduz a referência byte a byte e **recusa entradas que gravariam
  silêncio, um filtro instável ou pré-amp positivo** na flash. ✅
- A ordem das bandas importa: a referência põe **cortes antes dos reforços**, e
  inverter isso cria até +9 dB de pico interno (medido). ✅
- A spec oficial do PEQ **não é pública** (gated por NDA); FCC não se aplica a
  cabo USB sem rádio. ✅
