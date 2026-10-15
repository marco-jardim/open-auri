# Protocolo `0xCB` — wire format

Reconstruído a partir de uma implementação que **grava na flash** e é pública:
a página `https://equalizador.kuba.audio/` (artefato empacotado; analisado em 2026-10-14).

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
| Taxa de amostragem do DSP | **96 000 Hz** (`FS`) | ✅ |
| Requisitos | Chrome/Edge desktop, contexto seguro (HTTPS), gesto do usuário | ✅ |

## Estrutura do payload (blob)

O blob enviado ao chip tem **220 bytes**, montados assim:

| Campo | Bytes | Formato | Confiança |
|---|---|---|---|
| Chave fixa (HEADER) | 14 | bytes literais | ✅ |
| Pré-amp | 4 | `int32` LE, **Q23** (`2^23 = 8388608`) | ✅ |
| 10 bandas × 5 coef. | 200 | `int32` LE, **Q27** (`2^27 = 134217728`) | ✅ |
| CRC | 2 | CRC16-CCITT, LE | ✅ |
| **Total** | **220** | | ✅ |

### Chave fixa — 14 bytes

```
45 51 31 23 D6 00 00 0A 04 05 01 0A 00 00
```

Os primeiros quatro bytes são ASCII **`EQ1#`** (`0x45 0x51 0x31 0x23`).
O `0x0A` aparece nos offsets **7** e **11** — plausivelmente o número de bandas
(10). O significado dos demais bytes é 🟡 (não documentado).

### Pré-amp

Ganho linear em Q23:

```
pre_i32 = round(10^(pre_dB / 20) * 2^23)
```

1.0 ⇒ `0x00800000`. Escrito em little-endian (4 bytes).

### Bandas — ordem dos coeficientes

Cada banda grava **5 inteiros** `int32` LE, em Q27, nesta ordem exata:

```
[ b0, b2, -a1, b1, -a2 ]
```

com `a0` **implícito = 1** (coeficientes normalizados por `a0`).
`n = round(v * 134217728)`; se `n` não couber em `int32`, a gravação é rejeitada.

### CRC

**CRC16-CCITT** — polinômio `0x1021`, valor inicial `0xFFFF`, sem reflexão:

```
c = 0xFFFF
para cada byte x:
    c ^= x << 8
    repetir 8x:
        c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF
```

Anexado ao **fim do blob** como 2 bytes little-endian. ✔️ (o CRC *entra* no
stream transmitido, pois é calculado sobre o blob e incluído nele antes do fatiamento.)

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

O comando de commit faz o chip **persistir o preset na própria flash** — depois
disso vale em qualquer aparelho, sem software.

## Importante: o wire format é **biquad cru**

Não há **byte de tipo de filtro** por banda — só os 5 coeficientes. Logo, o chip
aplica *qualquer* biquad estável; o `type` (`PK`/`LS`) usado pela página é apenas
conveniência de cálculo no JS.

⇒ É possível enviar **HS, HP, LP, notch, band-pass, all-pass, shelf de 1ª ordem**,
etc., contanto que os coeficientes passem na validação. 🟡 (o formato permite;
o firmware aceitar de fato é ❌)

## Ordenação das bandas

As bandas são **biquads em série**, e filtros lineares invariantes no tempo
**comutam**: a resposta não depende da ordem. ✅

Consequência prática: qualquer preset pode ser **canonizado ordenado por `f`**,
o que torna diff, hash e comparação determinísticos de graça. Os coeficientes
são calculados por banda e não mudam com a reordenação — só mudam de posição no
blob.

> ⚠️ A comutatividade é exata para o filtro ideal; a implementação em ponto fixo
> do chip pode diferir em arredondamento conforme a ordem interna, o que é
> desprezível. Na dúvida, não reordene o que já funciona.

Uso: [`social.md`](social.md) (S1).

## Limites práticos do formato

| Constrição | Valor | Confiança |
|---|---|---|
| Seções | **exatamente 10** | ✅ |
| Ordem por seção | 1 biquad (2ª ordem) | ✅ |
| Faixa do coeficiente | \|coef\| < 16 (Q27 → int32) ⇒ **~±24 dB** por seção | 🟡 |
| Estabilidade | polos dentro do círculo unitário | 🟡 |
| Frequência | `> 0` e `< 48 kHz` (Nyquist de 96 k) | ✅ |
| Ganho global | **1** pré-amp por preset | ✅ |

Banda "desligada": com `g = 0` o biquad RBJ vira identidade
(`b0 = 1, b1 = a1, b2 = a2`), então 10 bandas cobrem de 1 a 10 seções reais. 🟡

## Design dos biquads (RBJ)

A página calcula os coeficientes com as fórmulas de **RBJ cookbook** (peak e
low-shelf) em `FS = 96 kHz` e normaliza por `a0`. Ver
[`ecosystem.md`](ecosystem.md) para as implementações de referência equivalentes.

## Duas observações sobre a página analisada

1. **`show` vs `bands`.** A curva **desenhada** usa `p.show || p.bands`, mas o
   que é **gravado** usa `p.bands`. No preset `pref6` ("Natural") os dois conjuntos
   são diferentes — logo gráfico e preset gravado **não coincidem** nesse caso. ✅
2. **`pre` por preset.** Cada preset traz um pré-amp único, usado para igualar o
   volume entre presets entre 300 Hz e 3 kHz. ✅

## Como reproduzir a extração

A página é um artifact empacotado; o app inteiro vive num
`<script type="__bundler/template">` codificado em JSON.

```powershell
$out = "$env:TEMP\kuba"
New-Item -ItemType Directory -Force -Path $out | Out-Null
$raw = (Invoke-WebRequest -Uri "https://equalizador.kuba.audio/" -UseBasicParsing).Content
$m = [regex]::Match($raw, '<script type="__bundler/template">([\s\S]*?)</script>')
[IO.File]::WriteAllText("$out\template.html", ($m.Groups[1].Value.Trim() | ConvertFrom-Json))
```

O objeto `DSP` no template contém `HEADER`, `APPLY`, `FS`, `VENDOR_ID`,
`PRODUCT_ID`, `REPORT_ID` e as funções `peak`/`lowShelf`/`coeffs`/`crc16`/`blob`/
`packets`/`response`.
