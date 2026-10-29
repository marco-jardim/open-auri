# Protocolo `0xCB`: wire format

Reconstruído a partir de uma implementação que **grava na flash** e é pública:
a página `https://equalizador.kuba.audio/` (artefato empacotado; analisado em
2026-10-14, revisado em 2026-10-15).

> **Status.** O *formato do byte-stream* abaixo é ✅ (vem de código que funciona).
> A execução real no chip é ❌ até termos o cabo: nenhum byte foi transmitido
> por nós.

## Transporte

| Item | Valor | Confiança |
|---|---|---|
| API | **WebHID** (`navigator.hid`) | ✅ |
| VID / PID | `0x3302` / `0x8902` | ✅ |
| Report ID | **`0xCB`** | ✅ |
| Tamanho do relatório | **31 bytes** | ✅ |
| Taxa de amostragem do DSP | **96 000 Hz** (`FS`); ver nota abaixo | ✅ (formato) / 🟡 (chip) |
| Requisitos | Chrome/Edge desktop, contexto seguro (HTTPS), gesto do usuário | ✅ |

**Sobre o `FS`.** Três implementações independentes projetam os coeficientes em
96 kHz: a página do kuba (`0xCB`), o `eqloader` (`DEVICE_SAMPLE_RATE = 96000`,
*"Rate the device's biquad coefficients are designed at"*) e os testes do
`frost-tune` (`0x4B`). Se o núcleo seguisse a taxa do stream, um conteúdo a
44,1 kHz deslocaria toda a curva por 2,18×, algo que não passaria despercebido
em três ferramentas. A hipótese mais provável é um núcleo em **taxa fixa de
96 kHz**. Ainda assim é inferência; a confirmação é a sonda B10
([`probing.md`](probing.md)).

## Estrutura do payload (blob)

O blob enviado ao chip tem **220 bytes**, montados assim:

| Campo | Bytes | Formato | Confiança |
|---|---|---|---|
| Header | 14 | ver abaixo | ✅ |
| Pré-amp | 4 | `int32` LE, **Q23** (`2^23 = 8388608`) | ✅ |
| 10 bandas × 5 coef. | 200 | `int32` LE, **Q27** (`2^27 = 134217728`) | ✅ |
| CRC | 2 | CRC16-CCITT, LE | ✅ |
| **Total** | **220** | | ✅ |

### Header: 14 bytes

```
45 51 31 23 D6 00 00 0A 04 05 01 0A 00 00
```

| Offset | Bytes | Leitura | Confiança |
|---|---|---|---|
| 0–3 | `45 51 31 23` | ASCII **`EQ1#`**: *magic* (talvez "formato EQ, versão 1") | ✅ (ASCII) / 🟡 (significado) |
| 4–5 | `D6 00` | **u16 LE = 214 = 220 − 6**: comprimento de tudo que vem depois, CRC incluído | 🟡 (bate exatamente) |
| 6 | `00` | ? | ❌ |
| 7 | `0A` | 10: nº de seções? | 🟡 |
| 8 | `04` | 4: bytes por coeficiente (`int32`)? | 🟡 |
| 9 | `05` | 5: coeficientes por seção? | 🟡 |
| 10 | `01` | 1: nº de canais? nº de palavras de pré-amp? | 🟡 |
| 11 | `0A` | 10: nº de seções (de novo; talvez "ativas" vs "máximo")? | 🟡 |
| 12–13 | `00 00` | reservado? | ❌ |

O padrão sugere um **header autodescritivo**: comprimento + geometria do bloco.
Duas consequências, ambas a confirmar no cabo:

- se o byte 10 for **nº de canais**, pode existir **EQ independente por canal**
  (10 seções × 2), o que hoje está listado como impossível;
- se o firmware respeitar os bytes 7/11, pode aceitar **menos (ou mais) de 10
  seções**, com o comprimento do byte 4–5 ajustado.

O teste `preamble bytes 4..5 are a u16 LE length` fixa a parte verificável.

O app oficial WalkPlay confirma parte disso: calcula os bytes 4–5 como
`14 + 20·n` e escreve `n` (nº de filtros ativos) nos bytes 7 e 11; os demais são
constantes no app. Ver
[Confirmação pelo app oficial](#confirmação-pelo-app-oficial-walkplay).

### Pré-amp

Ganho linear em Q23:

```
pre_i32 = round(10^(pre_dB / 20) * 2^23)
```

1.0 ⇒ `0x00800000`. Escrito em little-endian (4 bytes).

O codec recusa pré-amp **não finito** e **positivo**. O pré-amp atua antes das
bandas, então qualquer ganho acima de 0 dB clipa conteúdo em escala cheia. Todos
os 11 presets da referência usam pré-amp entre −7,8 e −0,5 dB.

Consequência: uma curva só de cortes sai mais baixa que o original, e o codec não
deixa compensar isso com pré-amp positivo; o volume se recupera no volume do
sistema. A sonda B9 de pré-amp positivo, se um dia for feita, terá de montar os
bytes fora do codec, de propósito.

### Bandas: ordem dos coeficientes

Cada banda grava **5 inteiros** `int32` LE, em Q27, nesta ordem exata:

```
[ b0, b2, -a1, b1, -a2 ]
```

com `a0` **implícito = 1** (coeficientes normalizados por `a0`).
`n = round(v * 134217728)`.

### CRC

**CRC16-CCITT** (variante *CCITT-FALSE*): polinômio `0x1021`, valor inicial
`0xFFFF`, sem reflexão, sem XOR final. Vetor de verificação: `"123456789"` ⇒
`0x29B1` ✅ (testado de forma independente da referência).

```
c = 0xFFFF
para cada byte x:
    c ^= x << 8
    repetir 8x:
        c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF
```

Calculado sobre os 218 bytes anteriores e anexado ao **fim do blob** como 2 bytes
little-endian. ✅ Se o firmware **valida** o CRC é outra questão (sonda B7).

## Fatiamento em relatórios

O blob de 220 bytes é dividido em **9 relatórios de 31 bytes**:

```
pacote[i] = [ i, blob[30*i .. 30*i+29] ]     // i = 0..8
```

- byte `0` = índice do pacote (`0..8`);
- bytes `1..30` = 30 bytes de dados.

Distribuição real: os pacotes `0..6` vão cheios (210 bytes), o pacote `7` leva
10 bytes e o pacote `8` vai vazio. Ainda assim, **os 9 são enviados**.

## Sequência de gravação

```
para cada pacote (9):
    device.sendReport(0xCB, pacote)
    espera 16 ms
espera 150 ms
device.sendReport(0xCB, [0x01, 0x65, 0x00, 0x01, 0xFF])   // COMMIT
```

| Passo | Comando | Confiança |
|---|---|---|
| Dados | 9 × relatório `0xCB` | ✅ |
| Pausa | 16 ms entre pacotes | ✅ |
| Settle | 150 ms | ✅ |
| **Commit / APPLY** | `[0x01, 0x65, 0x00, 0x01, 0xFF]` | ✅ |

O commit faz o chip **persistir o preset na própria flash**. Depois disso vale
em qualquer aparelho, sem software.

**Tamanho do commit.** A referência envia **5 bytes** num report declarado com
31. O codec expõe `commitReport()`, que completa com zeros até 31, para que
qualquer transporte (WebHID, hidapi, Windows) envie os mesmos bytes. Se o
firmware distingue os dois casos é 🟡.

**Desgaste.** Cada commit é uma gravação na flash, cuja durabilidade é
desconhecida, e um corte de energia no meio da gravação tem efeito desconhecido.
Omitir o commit evita a flash (ver abaixo). Os bytes `01 FF` no fim do APPLY são
candidatos a flags 🟡; B12 omitiu o commit inteiro, sem variá-los.

## Dados = RAM, commit = flash

Medido no cabo (sondas B12 e B12b, `docs/probing.md`, seção F):

| Fato | Sonda | Confiança |
|---|---|---|
| Os 9 reports de dados **sem** o commit mudam o som na hora (RAM) | B12 | ✅ |
| Depois de desconectar e reconectar, o cabo volta à última curva **commitada** (flash) | B12 | ✅ |
| Só os reports `0..6`, ou só `0..7` (com o CRC), **não** mudam o som: a curva entra quando o report `8` chega | B12b | ✅ |
| Uma sequência completa enviada depois de uma parcial funciona normalmente | B12b | ✅ |
| Curva com CRC errado é ignorada em silêncio | B7 | ✅ |
| O cabo não responde às gravações (sem input reports); só responde ao pedido de tag `80 00 00 00 FF` ([ver abaixo](#confirmação-pelo-app-oficial-walkplay)) | — / leitura de tag | ✅ |

No transporte (`src/transport/webhid.mjs`), `applyCurve` envia os 9 reports com
as mesmas pausas e o mesmo settle de 150 ms, **sem** o commit (prévia ao vivo,
sem flash); `writeCurve` envia os 9 reports e o commit (persistir). Uma
sequência interrompida antes de o report `8` sair deixa o cabo na curva
anterior; interrompida depois dele, o cabo pode já soar como a curva nova até
ser reconectado.

## Confirmação pelo app oficial (WalkPlay)

Analisado em 2026-10-28. O app web oficial de PEQ da WalkPlay
([`peq.szwalkplay.com`](https://peq.szwalkplay.com/)) contém uma classe de
dispositivo que fala exatamente este protocolo: grupo `"CB"`, prefixo de log
`"CB1100AU"`. O código lido é o do espelho offline
[`Ircama/walkplay`](https://github.com/Ircama/walkplay), arquivo
`public/assets/index-BEOfvcHi.js`. É uma segunda implementação, independente
da página do kuba.

Ressalvas sobre o app:

- **O caminho principal do app não usa essa classe.** A fábrica de classes
  mapeia `CB → t2` e `CB1100AU → m2`, mas a inicialização passa sempre o tipo
  `'CB'`, que cria a classe genérica `t2`: report `0x4B` (75), registros de
  36 bytes por banda, leitura de versão `80 0C`. O Kuba Auri não expõe o
  report `0x4B`, então o app, como publicado, provavelmente não controla este
  cabo. A classe `CB1100AU` aparece só no mapa da fábrica e nos logs.
- **Taxa de amostragem.** A classe `CB1100AU` declara `sampleRate = 48000`,
  mas o cálculo dos biquads usa `π·f/48000`, o mesmo ângulo de `2π·f/96000`.
  O projeto efetivo é a **96 kHz**, igual à página do kuba, ao open-auri e à
  medição B10.

> **"A página nunca lê" continua valendo para a página do kuba.** O protocolo,
> porém, tem **exatamente uma leitura**: a tag de EQ (abaixo). Versão de
> firmware e curva gravada **não** podem ser lidas deste cabo.

### Constantes da classe

| Constante | Valor | Confere com |
|---|---|---|
| `REPORT_ID` | `203` (`0xCB`) | report ID da página do kuba ✅ |
| `HID_PACKET_SIZE` | `32` (report ID + 31) | relatório de 31 bytes ✅ |
| `HID_PACKET_PAYLOAD` | `30` | 30 bytes de dados por pacote ✅ |
| `MAX_PACKETS` | `9` | 9 pacotes ✅ |
| `COEFF_Q` | `1 << 27` | coeficientes Q27 ✅ |
| `GAIN_Q` | `1 << 23` | pré-amp Q23 ✅ |
| *magic* do frame | `"EQ1#"` | `45 51 31 23` ✅ |
| Tipos de filtro | `{LS: 1, PK: 2, HS: 3, LP: 4, HP: 5}` | tipos de cálculo no app; o fio continua sem byte de tipo |

### Frame (`buildEqBuffer`)

```
45 51 31 23                     "EQ1#"
LL LL                           u16 LE = 14 + 20·n
00 n 04 05 01 n 00 00           n = nº de filtros ATIVOS
PP PP PP PP                     pré-amp int32 LE = round(10^(dB/20) · 2^23)
n × [b0, b2, −a1, b1, −a2]      5 × int32 LE, Q27
CC CC                           CRC-16/CCITT-FALSE (init 0xFFFF, poly 0x1021), LE,
                                sobre todos os bytes anteriores
```

Dividido em 9 pacotes: byte `0` = índice, depois 30 bytes de dados.

| Fato | Consequência para este documento |
|---|---|
| O comprimento é calculado como `14 + 20·n` | confirma a leitura dos bytes 4–5 como comprimento (`n = 10` ⇒ `214 = 0xD6`) |
| Os bytes 7 e 11 recebem `n` | são a contagem de filtros; os bytes 6, 8–10 e 12–13 são constantes (`00`, `04 05 01`, `00 00`) cujo nome o app não revela |
| O app envia **só os filtros ativos** (`n` variável) | a página do kuba e o open-auri sempre enviam `n = 10` (bandas `OFF` como identidade); frames com `n < 10` **não foram testados neste cabo** |
| O pré-amp é **negado** quando uma flag interna está ligada | significado da flag não identificado |

### Comando final: salvar × aplicar

Depois dos pacotes, o app envia um de dois comandos:

| Função no app | Bytes | Efeito declarado |
|---|---|---|
| `saveEqInfo` | `01 <tag> 00 01 FF` | aplicar e **persistir na flash** |
| `setEqInfo` | `01 <tag> 00 00 FF` | aplicar **sem salvar** |

Com a tag `0x65`, `saveEqInfo` é exatamente o commit da página do kuba
(`01 65 00 01 FF`). Os dois comandos só diferem no byte `3` (`01` salva,
`00` não salva).

Não verificado no hardware: o efeito acústico de `01 65 00 00 FF` comparado com
enviar só os dados. A B12 mostrou que os 9 reports de dados **sozinhos** já
aplicam ao vivo; o open-auri usa esse caminho (sem comando final) para a prévia
no cabo.

### Leitura da tag de EQ

A única leitura que a classe implementa é `readEqTagId`:

| Direção | Report | Bytes |
|---|---|---|
| pedido (output) | `0xCB` | `80 00 00 00 FF` |
| resposta (input) | `0xCB` | `80 <tag> …` (`handleInputReport`: se `e[0] == 0x80`, então `tag = e[1]`) |

Medido no Kuba Auri real (2026-10-28): pedido `80 00 00 00 FF` ⇒ resposta
`80 65 00 00 ff 00 …` (31 bytes) ⇒ tag **`0x65` (101)**, a mesma do commit.

### O que o app declara não suportado

Para esta classe, o app marca como `"芯片不支持"` ("o chip não suporta"):

| Função | O que seria |
|---|---|
| `readDeviceVersion` | versão de firmware |
| `readFilterInfo` | ler os filtros gravados (curva) |
| `readEqOffset`, `readMicphoneOffset` | ler offsets de EQ / microfone |
| `selectFilter` | selecionar filtro do DAC |
| `setDacWorkMode`, `setDacOffsetMode`, `setDacBalance` | modo, offset e balanço do DAC |
| `saveMicphoneOffset` | gravar offset do microfone |
| `resetDevice` | reset |

E também `getIsSupportNoiseReduction = false` e
`getIsSupportDacFilterMode = false`.

Consequência: **versão de firmware e curva gravada não podem ser lidas deste
cabo**; só a tag de EQ. Sem read-back, a última curva conhecida continua sendo
a registrada no host.

### Chip

O app chama a classe de `"CB1100AU"`. O brief de módulo da TTGK
`TT39510B01` (2024-06-14,
[PDF](https://szttgk.com/uploads/files/20240725/51fad44bb79a05a35046af38b0017de5.pdf))
descreve o bridge de áudio USB **CB5100** com DSP/ADC/PGA e EQ, e
*"支持WALK PLAY APP EQ联动"* (integração de EQ com o app Walk Play); página do
produto:
[CB5100PRO](https://szttgk.com/en/product/HIFIhighfidelityaudiomodule/815.html).
O brief **não traz protocolo HID**. Se o chip do Auri é o CB5100 ou uma variante
"CB1100AU" **não está confirmado**.

## Parentesco com o `0x4B`

Duas coincidências sugerem que os dois formatos vêm do **mesmo SDK**:

| Observação | Valor | Confiança |
|---|---|---|
| Report ID | `0xCB = 0x4B \| 0x80`, e `0x80` é a flag de **leitura** do `0x4B` | ✅ (aritmética) / 🟡 (significado) |
| Commit | contém `0x65 = 101`, o mesmo `FILTER_SLOT` do `0x4B` | ✅ (aritmética) / 🟡 (significado) |

Consequência prática: o cabo pode expor **também** o report `0x4B`, e então
leitura, versão, ganho e slots poderiam funcionar com as ferramentas existentes.
É verificável sem risco, lendo `HIDDevice.collections` (sonda B1).

## O wire format é **biquad cru**

Não há **byte de tipo de filtro** por banda, só os 5 coeficientes. Logo, o chip
aplica *qualquer* biquad estável; o `type` usado pela página é conveniência de
cálculo no JS.

⇒ É possível enviar **HS, HP, LP, notch, band-pass, all-pass, shelf de 1ª ordem**,
etc. 🟡 (o formato permite; o firmware aceitar de fato é ❌)

## Ordenação das bandas: **cortes antes dos reforços**

A resposta em frequência **ideal** não depende da ordem das seções (filtros
lineares invariantes no tempo comutam). ✅ O **pico interno** da cadeia depende.

A fonte da referência diz, na linha que antecede os presets:

> *"Pré-amps igualam o volume dos presets entre 300 Hz e 3 kHz, **sem clipping
> (cortes antes dos reforços)**."*

E todos os 11 presets seguem a regra. Medição do pico interno (pior estágio da
cadeia, senoide em 0 dBFS na entrada, pré-amp incluído):

| Ordem | Pior pico interno (11 presets) | Presets acima de 0 dBFS |
|---|---|---|
| da referência (cortes primeiro) | **−0,20 dB** | 0 |
| ordenada por `f` | **+4,79 dB** | 7 |
| invertida (reforços primeiro) | **+9,13 dB** | 11 |

Consequências:

- **A ordem enviada ao chip tem que manter cortes antes dos reforços.** O codec
  escreve na ordem recebida; quem monta o preset é responsável por ela.
- **Ordenar por `f` serve só para forma canônica** (compartilhar, comparar, hash),
  nunca para o envio. Ver [`social.md`](social.md) (S1).
- Se o chip tem bits de guarda internos é desconhecido; a regra vale como padrão
  seguro de qualquer forma.

## Limites práticos do formato (medidos)

| Constrição | Valor | Confiança |
|---|---|---|
| Seções | **10** no formato conhecido (header pode permitir outras contagens) | ✅ / 🟡 |
| Ordem por seção | 1 biquad (2ª ordem) | ✅ |
| Faixa do coeficiente | \|coef\| < 16 (Q27 em `int32`). **Depende do tipo**: o primeiro estouro aparece em PK **+31 dB** (20 kHz, Q 0,1), LS **+48,5 dB**, HS **+18,5 dB** (20 Hz, Q 0,1). **Cortes nunca estouram** (−80 dB passa) | ✅ (medido) |
| Erro de quantização Q27 | pior caso nos 11 presets **0,0036 dB**; caso extremo (PK 20 Hz, Q 10, −12 dB) **0,017 dB**: irrelevante | ✅ (medido) |
| Estabilidade | polos estritamente dentro do círculo unitário, **verificado pelo codec nos coeficientes já quantizados** | ✅ |
| Frequência | `0 < f < 48 kHz` (Nyquist de 96 k), verificado pelo codec | ✅ |
| Ganho global | **1** pré-amp por preset | ✅ |

O antigo "~±24 dB por seção" estava errado: o limite depende do tipo e quase
nunca é o que restringe uma curva real.

### Banda desligada

Use a **identidade exata**: `{ kind: 'OFF' }` ⇒ `[2^27, 0, 0, 0, 0]`. Um peaking
com `g = 0` também tem resposta plana, mas mantém polos perto do círculo unitário
(em baixa frequência e Q alto); em ponto fixo, o ruído de arredondamento passa
por esses polos. A identidade exata não custa nada. `NEUTRAL_BANDS` são 10
seções `OFF`: o preset neutro garantido.

## Validação no codec

`encodePayload()` é a última barreira antes da flash, e a flash não pode ser lida de
volta. Ele recusa:

| Entrada | Sem validação, gravaria |
|---|---|
| `q = 0`, `f = NaN` | uma seção toda zero ⇒ **cabo mudo** |
| `q < 0`, `f > Nyquist` | uma seção **instável** ⇒ oscilação em volume máximo |
| `g` ou pré-amp não finitos | valores arbitrários |
| pré-amp **> 0 dB** | ganho antes das bandas ⇒ clipping de conteúdo em escala cheia |
| tipo desconhecido (`LSQ`, `HSQ`, ausente) | um peaking no lugar de um shelf |
| coeficiente fora de `int32` | não se aplica (já era recusado) |

Nomes como `LSQ`/`HSQ` (EqualizerAPO, hangout.audio) precisam ser mapeados
explicitamente por quem importa o arquivo.

## Design dos biquads (RBJ)

A página calcula os coeficientes com as fórmulas do **RBJ cookbook** (peak e
low-shelf) em `FS = 96 kHz` e normaliza por `a0`.

O codec do projeto não usa o código da página:

| Parte | Origem |
|---|---|
| peaking, low shelf, high shelf | porte do **AutoEq** (MIT), `autoeq/peq.py`, na mesma ordem de operações |
| low pass, high pass | RBJ cookbook diretamente (o AutoEq não tem) |
| `OFF` | identidade exata |
| magnitude (`magnitudeDb`) | própria: expansão em torno de z⁻¹ = 1 |

O AutoEq segue o cookbook na mesma ordem de operações que a página, e a convenção
de sinal dele (realimentação negada) difere só por negações, que são exatas em
IEEE 754. Por isso os bytes são idênticos, o que foi verificado no fixture e em 196 mil
bandas aleatórias ([`verification.md`](verification.md)).

A magnitude **não** vem do AutoEq: a fórmula dele (`PEQFilter.fr`, com
φ = 4·sin²(ω/2)) é 35× menos precisa em baixa frequência com Q alto. Medido
contra a avaliação exata dos mesmos coeficientes:

| Método | Pior erro |
|---|---|
| forma direta (versão anterior) | 4,4·10⁻⁹ dB |
| AutoEq (φ) | 1,5·10⁻⁷ dB |
| **expansão em u = 1 − z⁻¹ (atual)** | **5,7·10⁻¹⁴ dB** |

## Duas observações sobre a página analisada

1. **`show` vs `bands`.** A curva **desenhada** usa `p.show || p.bands`, mas o
   que é **gravado** usa `p.bands`. No preset `pref6` ("Natural") os dois
   conjuntos diferem (medido, com alinhamento em 300 Hz–3 kHz como a página faz):

   | Faixa | Maior diferença |
   |---|---|
   | 20–300 Hz | 0,88 dB |
   | 300 Hz–3 kHz | 1,34 dB |
   | 3–8 kHz | **3,87 dB** (faixa que a referência diz priorizar) |
   | 8–16 kHz | **7,29 dB** @ 11,5 kHz |

2. **`pre` por preset.** Cada preset traz um pré-amp que iguala o volume entre
   300 Hz e 3 kHz. Medido: a saída de todos fica ≤ −0,47 dB (senoide em 0 dBFS),
   ou seja, a afirmação "sem clipping" da referência se confirma para regime
   permanente. Sinais de banda larga podem ter overshoot acima disso.

## Como reproduzir a extração

A página é um artifact empacotado; o app inteiro vive num
`<script type="__bundler/template">` codificado em JSON. O gerador do fixture
só executa esse código se o sha256 dele bater com um hash revisado e pinado:

```powershell
npm run fixtures:reference
```

Baixa a página e regenera o fixture **somente se** ela ainda bater com o sha256
pinado no próprio fixture. Se a página mudou, nada é executado: o comando sai
com erro, diz onde salvou a versão nova e como pinar de novo depois de revisar.

Para revisar uma versão nova manualmente:

```powershell
node tools/extract-kuba-reference.mjs --fetch "$env:TEMP\kuba-template.html"
# revisar o arquivo; anotar o sha256 impresso
node tools/extract-kuba-reference.mjs --template "$env:TEMP\kuba-template.html" --expect-sha256 <hash>
```

O objeto `DSP` no template contém `HEADER`, `APPLY`, `FS`, `VENDOR_ID`,
`PRODUCT_ID`, `REPORT_ID` e as funções `peak`/`lowShelf`/`coeffs`/`crc16`/`blob`/
`packets`/`response`. O sha256 do template usado está em
`test/fixtures/eq0xcb.reference.json` (`_provenance.templateSha256`).
