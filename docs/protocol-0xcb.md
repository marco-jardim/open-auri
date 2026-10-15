# Protocolo `0xCB` — wire format

Reconstruído a partir de uma implementação que **grava na flash** e é pública:
a página `https://equalizador.kuba.audio/` (artefato empacotado; analisado em
2026-10-14, revisado em 2026-10-15).

> **Status.** O *formato do byte-stream* abaixo é ✅ (vem de código que funciona).
> A execução real no chip é ❌ até termos o cabo — nenhum byte foi transmitido
> por nós.

## Transporte

| Item | Valor | Confiança |
|---|---|---|
| API | **WebHID** (`navigator.hid`) | ✅ |
| VID / PID | `0x3302` / `0x8902` | ✅ |
| Report ID | **`0xCB`** | ✅ |
| Tamanho do relatório | **31 bytes** | ✅ |
| Taxa de amostragem do DSP | **96 000 Hz** (`FS`) — ver nota abaixo | ✅ (formato) / 🟡 (chip) |
| Requisitos | Chrome/Edge desktop, contexto seguro (HTTPS), gesto do usuário | ✅ |

**Sobre o `FS`.** Três implementações independentes projetam os coeficientes em
96 kHz: a página do kuba (`0xCB`), o `eqloader` (`DEVICE_SAMPLE_RATE = 96000`,
*"Rate the device's biquad coefficients are designed at"*) e os testes do
`frost-tune` (`0x4B`). Se o núcleo seguisse a taxa do stream, um conteúdo a
44,1 kHz deslocaria toda a curva por 2,18× — algo que não passaria despercebido
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

### Header — 14 bytes

```
45 51 31 23 D6 00 00 0A 04 05 01 0A 00 00
```

| Offset | Bytes | Leitura | Confiança |
|---|---|---|---|
| 0–3 | `45 51 31 23` | ASCII **`EQ1#`** — *magic* (talvez "formato EQ, versão 1") | ✅ (ASCII) / 🟡 (significado) |
| 4–5 | `D6 00` | **u16 LE = 214 = 220 − 6**: comprimento de tudo que vem depois, CRC incluído | 🟡 (bate exatamente) |
| 6 | `00` | ? | ❌ |
| 7 | `0A` | 10 — nº de seções? | 🟡 |
| 8 | `04` | 4 — bytes por coeficiente (`int32`)? | 🟡 |
| 9 | `05` | 5 — coeficientes por seção? | 🟡 |
| 10 | `01` | 1 — nº de canais? nº de palavras de pré-amp? | 🟡 |
| 11 | `0A` | 10 — nº de seções (de novo; talvez "ativas" vs "máximo")? | 🟡 |
| 12–13 | `00 00` | reservado? | ❌ |

O padrão sugere um **header autodescritivo**: comprimento + geometria do bloco.
Duas consequências, ambas a confirmar no cabo:

- se o byte 10 for **nº de canais**, pode existir **EQ independente por canal**
  (10 seções × 2) — o que hoje está listado como impossível;
- se o firmware respeitar os bytes 7/11, pode aceitar **menos (ou mais) de 10
  seções**, com o comprimento do byte 4–5 ajustado.

O teste `header bytes 4..5 are a u16 LE length` fixa a parte verificável.

### Pré-amp

Ganho linear em Q23:

```
pre_i32 = round(10^(pre_dB / 20) * 2^23)
```

1.0 ⇒ `0x00800000`. Escrito em little-endian (4 bytes). O codec recusa pré-amp
não finito; o sinal não é restringido (a sonda B9 precisa de pré-amp positivo).

### Bandas — ordem dos coeficientes

Cada banda grava **5 inteiros** `int32` LE, em Q27, nesta ordem exata:

```
[ b0, b2, -a1, b1, -a2 ]
```

com `a0` **implícito = 1** (coeficientes normalizados por `a0`).
`n = round(v * 134217728)`.

### CRC

**CRC16-CCITT** (variante *CCITT-FALSE*) — polinômio `0x1021`, valor inicial
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

O commit faz o chip **persistir o preset na própria flash** — depois disso vale
em qualquer aparelho, sem software.

**Tamanho do commit.** A referência envia **5 bytes** num report declarado com
31. O codec expõe `applyPacket()`, que completa com zeros até 31, para que
qualquer transporte (WebHID, hidapi, Windows) envie os mesmos bytes. Se o
firmware distingue os dois casos é 🟡.

**Desgaste.** Cada commit é uma gravação na flash, cuja durabilidade é
desconhecida, e um corte de energia no meio da gravação tem efeito desconhecido.
Não existe, até onde se sabe, um modo "só RAM" no `0xCB` (o `0x4B` tem
`TEMP_WRITE`). Os bytes `01 FF` no fim do APPLY são candidatos a flags 🟡.

## Parentesco com o `0x4B`

Duas coincidências sugerem que os dois formatos vêm do **mesmo SDK**:

| Observação | Valor | Confiança |
|---|---|---|
| Report ID | `0xCB = 0x4B \| 0x80` — e `0x80` é a flag de **leitura** do `0x4B` | ✅ (aritmética) / 🟡 (significado) |
| Commit | contém `0x65 = 101`, o mesmo `FILTER_SLOT` do `0x4B` | ✅ (aritmética) / 🟡 (significado) |

Consequência prática: o cabo pode expor **também** o report `0x4B` — e então
leitura, versão, ganho e slots poderiam funcionar com as ferramentas existentes.
É verificável sem risco, lendo `HIDDevice.collections` (sonda B1).

## O wire format é **biquad cru**

Não há **byte de tipo de filtro** por banda — só os 5 coeficientes. Logo, o chip
aplica *qualquer* biquad estável; o `type` usado pela página é conveniência de
cálculo no JS.

⇒ É possível enviar **HS, HP, LP, notch, band-pass, all-pass, shelf de 1ª ordem**,
etc. 🟡 (o formato permite; o firmware aceitar de fato é ❌)

## Ordenação das bandas — **cortes antes dos reforços**

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
- **Ordenar por `f` serve só para forma canônica** (compartilhar, comparar, hash)
  — nunca para o envio. Ver [`social.md`](social.md) (S1).
- Se o chip tem bits de guarda internos é desconhecido; a regra vale como padrão
  seguro de qualquer forma.

## Limites práticos do formato (medidos)

| Constrição | Valor | Confiança |
|---|---|---|
| Seções | **10** no formato conhecido (header pode permitir outras contagens) | ✅ / 🟡 |
| Ordem por seção | 1 biquad (2ª ordem) | ✅ |
| Faixa do coeficiente | \|coef\| < 16 (Q27 em `int32`). **Depende do tipo**: o primeiro estouro aparece em PK **+31 dB** (20 kHz, Q 0,1), LS **+48,5 dB**, HS **+18,5 dB** (20 Hz, Q 0,1). **Cortes nunca estouram** (−80 dB passa) | ✅ (medido) |
| Erro de quantização Q27 | pior caso nos 11 presets **0,0036 dB**; caso extremo (PK 20 Hz, Q 10, −12 dB) **0,017 dB** — irrelevante | ✅ (medido) |
| Estabilidade | polos estritamente dentro do círculo unitário — **verificado pelo codec nos coeficientes já quantizados** | ✅ |
| Frequência | `0 < f < 48 kHz` (Nyquist de 96 k) — verificado pelo codec | ✅ |
| Ganho global | **1** pré-amp por preset | ✅ |

O antigo "~±24 dB por seção" estava errado: o limite depende do tipo e quase
nunca é o que restringe uma curva real.

### Banda desligada

Use a **identidade exata**: `{ type: 'OFF' }` ⇒ `[2^27, 0, 0, 0, 0]`. Um peaking
com `g = 0` também tem resposta plana, mas mantém polos perto do círculo unitário
(em baixa frequência e Q alto); em ponto fixo, o ruído de arredondamento passa
por esses polos. A identidade exata não custa nada. `NEUTRAL_BANDS` são 10
seções `OFF` — o preset neutro garantido.

## Validação no codec

`blob()` é a última barreira antes da flash, e a flash não pode ser lida de
volta. Ele recusa:

| Entrada | Sem validação, gravaria |
|---|---|
| `q = 0`, `f = NaN` | uma seção toda zero ⇒ **cabo mudo** |
| `q < 0`, `f > Nyquist` | uma seção **instável** ⇒ oscilação em volume máximo |
| `g` ou pré-amp não finitos | valores arbitrários |
| tipo desconhecido (`LSQ`, `HSQ`, ausente) | um peaking no lugar de um shelf |
| coeficiente fora de `int32` | — (já era recusado) |

Nomes como `LSQ`/`HSQ` (EqualizerAPO, hangout.audio) precisam ser mapeados
explicitamente por quem importa o arquivo.

## Design dos biquads (RBJ)

A página calcula os coeficientes com as fórmulas do **RBJ cookbook** (peak e
low-shelf) em `FS = 96 kHz` e normaliza por `a0`. O codec acrescenta high-shelf,
low-pass, high-pass e `OFF`, verificados por propriedades do próprio cookbook
(ganho em f0, DC e Nyquist), não pela referência.

## Duas observações sobre a página analisada

1. **`show` vs `bands`.** A curva **desenhada** usa `p.show || p.bands`, mas o
   que é **gravado** usa `p.bands`. No preset `pref6` ("Natural") os dois
   conjuntos diferem — medido, com alinhamento em 300 Hz–3 kHz como a página faz:

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
faz isso em duas etapas, sem executar código vindo direto da rede:

```powershell
node tools/extract-kuba-reference.mjs --fetch "$env:TEMP\kuba-template.html"
# revisar o arquivo; anotar o sha256 impresso
node tools/extract-kuba-reference.mjs --template "$env:TEMP\kuba-template.html" --expect-sha256 <hash>
```

O objeto `DSP` no template contém `HEADER`, `APPLY`, `FS`, `VENDOR_ID`,
`PRODUCT_ID`, `REPORT_ID` e as funções `peak`/`lowShelf`/`coeffs`/`crc16`/`blob`/
`packets`/`response`. O sha256 do template usado está em
`test/fixtures/eq0xcb.reference.json` (`_provenance.templateSha256`).
