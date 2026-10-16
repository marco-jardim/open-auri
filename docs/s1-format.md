# Formato S1 v1 (congelado)

Código compacto, canônico e sem perda de uma curva de EQ de 10 bandas, para
circular num link (`#p=<código>`), num post ou num QR. Implementação:
[`src/share/s1.mjs`](../src/share/s1.mjs). Testes:
[`test/share/s1.test.mjs`](../test/share/s1.test.mjs).

Este documento substitui o desenho antigo de 48 B com CRC-8 descrito em
[`social.md`](social.md#s1--o-formato-compacto-). **A v1 está congelada:** nenhum
campo, faixa, ordem ou regra abaixo muda. Qualquer alteração é uma nova versão.

## Resumo

| Propriedade | Valor |
|---|---|
| Tamanho | **51 bytes** (408 bits, sem bits de enchimento) |
| Texto | **68 caracteres** base64url, sem `=` |
| Bandas | exatamente 10, na **ordem do fio** |
| Integridade | CRC-16/CCITT-FALSE sobre os 49 bytes anteriores |
| Perda | nenhuma, para qualquer valor da grade da UI |

## Grade sem perda

O formato representa **exatamente** todo valor desta grade (e só ela):

| Grandeza | Passo | Faixa |
|---|---|---|
| frequência | 1 Hz (inteiro) | 1 a 20 000 Hz |
| ganho | 0,1 dB | −25,6 a +12,7 dB |
| Q | 0,01 | 0,01 a 20,47 |
| pré-amp | 0,1 dB | 0 a −25,5 dB |

Os 11 presets oficiais (`test/fixtures/eq0xcb.reference.json`) e o Neutro (10
bandas `OFF`, pré-amp −0,5 dB) estão dentro da grade: codificar, decodificar e
gerar o payload de 220 B dá os mesmos bytes que o preset original.

## Layout de bits

Os campos são gravados em sequência, **bit mais significativo primeiro**
(big-endian de bits): o bit 0 é o bit 7 do byte 0. Não há alinhamento entre
campos.

| Bits (início) | Campo | Bits | Codificação | Faixa válida |
|---|---|---|---|---|
| 0 | versão | 2 | sem sinal | `1` (v1); 0, 2 e 3 reservados |
| 2 | variante | 2 | sem sinal | `0` (paramétrica); 1 a 3 reservados |
| 4 + 38·i | banda i: tipo | 3 | código da tabela abaixo | 0 a 5 |
| 7 + 38·i | banda i: frequência | 15 | Hz, sem sinal | 1 a 20 000 |
| 22 + 38·i | banda i: ganho | 9 | décimos de dB, complemento de dois | −256 a +127 |
| 31 + 38·i | banda i: Q | 11 | centésimos, sem sinal | 1 a 2047 |
| 384 | pré-amp | 8 | décimos de dB **abaixo de 0**, sem sinal | 0 a 255 |
| 392 | CRC | 16 | CRC-16/CCITT-FALSE, big-endian | qualquer |

`i` vai de 0 a 9, na ordem do fio. Cada banda ocupa 3 + 15 + 9 + 11 = 38 bits.
Total: 4 + 10 × 38 + 8 = 392 bits (49 bytes exatos) mais 16 de CRC = 408 bits
= 51 bytes.

### Códigos de tipo

| Código | Tipo | Campos usados |
|---|---|---|
| 0 | `PK` (peaking) | frequência, ganho, Q |
| 1 | `LS` (low shelf) | frequência, ganho, Q |
| 2 | `HS` (high shelf) | frequência, ganho, Q |
| 3 | `LP` (passa-baixa) | frequência, Q (ganho = 0) |
| 4 | `HP` (passa-alta) | frequência, Q (ganho = 0) |
| 5 | `OFF` (passagem direta) | nenhum (todos = 0) |
| 6, 7 | inválidos | recusados (`s1:kind`) |

A tabela pertence ao S1 e está congelada; ela coincide hoje com a ordem de
`FILTER_KINDS` do codec, mas não depende dela.

### Ordem de bytes

- Campos: MSB primeiro, sem alinhamento a byte.
- CRC: byte alto em `bytes[49]`, byte baixo em `bytes[50]`.

## CRC

CRC-16/CCITT-FALSE: polinômio `0x1021`, valor inicial `0xFFFF`, sem reflexão de
entrada nem de saída, sem XOR final (verificação: `"123456789"` dá `0x29B1`). É o
mesmo `crc16Ccitt` de `src/dsp/eq0xcb.mjs`, já usado no payload do cabo.

Cobertura: os bytes 0 a 48 (versão, variante, as 10 bandas e o pré-amp). O
CRC-16 detecta qualquer erro de até 3 bits e qualquer rajada de até 16 bits; o
CRC-8 do desenho antigo deixava passar 1 em 256 trocas aleatórias, o que era
pouco para um código que viaja por copiar e colar.

## base64url

Alfabeto do RFC 4648 §5 (`A-Z a-z 0-9 - _`), **sem padding**. Como 51 bytes são
17 grupos de 3, o texto tem exatamente 68 caracteres e nenhum bit sobra: não há
bits finais que possam variar, o que mantém o texto canônico. Qualquer outro
caractere, inclusive `=`, `+`, `/` e espaço, é recusado.

O primeiro caractere carrega a versão e a variante. Na v1 paramétrica ele é
`Q` para `PK`/`LS`, `R` para `HS`/`LP` ou `S` para `HP`/`OFF`: os 2 bits finais
são o começo do tipo da banda 0. `T` indicaria um tipo inválido (código 6 ou 7).

## Regras canônicas

Uma curva tem **um único** código S1, e um código válido tem uma única curva:

1. **Bandas `OFF`:** frequência, ganho e Q gravados como 0. Na leitura, qualquer
   desses campos diferente de 0 é recusado (`s1:noncanonical`). Na escrita,
   campos extras num objeto `{ kind: 'OFF', ... }` são ignorados, como faz o
   codec.
2. **`LP`/`HP` não têm ganho:** o campo de ganho é gravado como 0. Na escrita,
   `gainDb` ausente ou igual a 0 é aceito; qualquer outro valor é recusado
   (`s1:range`). Na leitura, ganho diferente de 0 é recusado
   (`s1:noncanonical`) e a banda volta **sem** `gainDb`
   (`{ kind, freqHz, qFactor }`). O payload do cabo é idêntico nos dois casos,
   porque o desenho de LP/HP ignora o ganho.
3. **Valores fora da faixa nunca são gravados:** frequência 0 ou acima de
   20 000, ganho acima de +12,7 dB (códigos 128 a 255 no campo de 9 bits) e Q 0
   são recusados na leitura (`s1:range`).
4. **Sem arredondamento:** a escrita aceita um número flutuante que esteja na
   grade com tolerância de 1e−9 (por exemplo `0.1 + 0.2` como Q 0,3) e grava o
   passo exato; fora dessa tolerância, recusa (`s1:grid`). Na leitura, os valores
   saem como `inteiro / 10` ou `inteiro / 100`, que são exatamente os mesmos
   números de ponto flutuante dos literais (`-2.8`, `0.69`).
5. **Pré-amp 0** volta como `0`, nunca como `-0`.
6. **Ordem do fio preservada:** as bandas não são ordenadas. O pico interno da
   cadeia depende da ordem (ver
   [`protocol-0xcb.md`](protocol-0xcb.md#ordenação-das-bandas--cortes-antes-dos-reforços)),
   então duas ordens diferentes são dois códigos diferentes.

## Códigos de erro

Todos os erros são `S1Error` com `code` estável; a mensagem começa por
`<code>: `.

### Leitura (`decodeS1`, `curveId`)

As verificações seguem esta ordem; vale o primeiro erro encontrado.

| Código | Quando |
|---|---|
| `s1:charset` | entrada não é texto, ou tem caractere fora de `[A-Za-z0-9_-]` (inclui `=`) |
| `s1:length` | texto vazio, ou comprimento diferente de 68 |
| `s1:version` | campo de versão diferente de 1 (lido do 1º caractere, antes do comprimento) |
| `s1:variant` | campo de variante diferente de 0 |
| `s1:crc` | CRC não confere |
| `s1:kind` | código de tipo 6 ou 7 |
| `s1:range` | frequência fora de 1 a 20 000, ganho acima de +12,7 dB, ou Q = 0 |
| `s1:noncanonical` | banda `OFF` com campo diferente de 0, ou `LP`/`HP` com ganho diferente de 0 |

A versão é lida antes do comprimento de propósito: um código de uma versão
futura, com outro tamanho, é reconhecido como `s1:version` e não como texto
truncado.

### Escrita (`encodeS1`, `canonKey`)

| Código | Quando |
|---|---|
| `s1:bands` | entrada não é objeto, ou `bands` não é uma lista de exatamente 10 objetos legíveis, sem lacunas |
| `s1:kind` | tipo desconhecido (por exemplo `LSQ`) |
| `s1:range` | valor não numérico ou não finito, fora da faixa, pré-amp positivo, ou `LP`/`HP` com ganho |
| `s1:grid` | valor fora da grade (por exemplo 100,5 Hz, −2,85 dB, Q 0,695) |

As duas APIs copiam a lista com `snapshotBands`: comprimento, cada índice e cada
campo de banda são lidos uma única vez. Lacunas, elementos que não são objetos
e falhas de leitura viram `S1Error` com código `s1:bands`.

## API

```js
import { encodeS1, decodeS1, canonKey, curveId } from './src/share/s1.mjs';

const s1 = encodeS1({ bands, preampDb }); // 68 caracteres
const { version, variant, bands, preampDb } = decodeS1(s1); // version 1, variant 0
const key = canonKey(bands, preampDb); // independe da ordem
const id = await curveId(s1); // 12 caracteres base32
```

- **`canonKey(bands, preampDb)`**: chave para deduplicar e comparar, igual para
  qualquer permutação das mesmas bandas. Formato:
  `v1;<pré-amp em décimos de dB>;<banda>;...;<banda>`, com cada banda como
  `TIPO,Hz,ganho em décimos,Q em centésimos` (`LP`/`HP` com ganho 0) ou `OFF`.
  Ordenação: frequência, código do tipo, Q e ganho, com as `OFF` no fim. Exemplo:
  `v1;-30;HP,20,0,71;PK,50,-10,200;...;OFF`. Essa ordem é só para guardar e
  comparar; **nunca** vai para o cabo.
- **`curveId(s1)`**: valida o código e devolve os 12 primeiros caracteres do
  base32 (RFC 4648, minúsculo, sem padding) do SHA-256 dos 51 bytes, na ordem do
  fio. Usa `globalThis.crypto.subtle` (WebCrypto), então roda em Node, navegador
  e Workers. É estável e muda quando a ordem muda; 12 caracteres são 60 bits.

## Exemplo: preset `padrao`

Entrada: pré-amp −2,8 dB e as bandas (todas `PK`):

| i | Hz | ganho (dB) | Q |
|---|---|---|---|
| 0 | 25 | −0,8 | 0,3 |
| 1 | 150 | −3 | 0,69 |
| 2 | 2237 | −10 | 1,41 |
| 3 | 4348 | −6,1 | 3 |
| 4 | 4958 | −8,3 | 2,72 |
| 5 | 7178 | −10 | 3 |
| 6 | 11063 | −10 | 3 |
| 7 | 520 | +3,1 | 0,81 |
| 8 | 3046 | +5,7 | 1,51 |
| 9 | 5995 | +3,4 | 0,59 |

Campos da banda 0: tipo `000`, frequência 25 = `000000000011001`, ganho −8 =
`111111000` (512 − 8 = 504), Q 30 = `00000011110`. Pré-amp: 28 = `00011100`.
Cabeçalho: versão `01`, variante `00`.

Bytes (hex, 51 B; os 2 últimos são o CRC `0xBC2F`):

```
40 00 67 f0 07 80 09 6f 10 45 02 2f 73 82 34 10
fc e1 92 c0 4d 7b 5a 44 01 c0 ac e1 2c 0a cd f3
84 b0 02 08 0f 85 10 2f 98 72 25 c1 76 b1 10 3b
1c bc 2f
```

Código S1 (68 caracteres):

```
QABn8AeACW8QRQIvc4I0EPzhksBNe1pEAcCs4SwKzfOEsAIID4UQL5hyJcF2sRA7HLwv
```

`curveId`: `mlz36rzp4knt`.

Os testes congelam esse texto, esses bytes e esse `curveId`.

## Política de versões

- **v1 está congelada.** Decodificadores v1 recusam tudo que não seja versão 1,
  variante 0 e 68 caracteres.
- A versão fica nos 2 primeiros bits, ou seja, no 1º caractere: um leitor sabe a
  versão antes de olhar o comprimento.
- Uma **v2** usa o valor de versão `2` e pode ter outro tamanho, outros campos e
  outra grade. O valor `3` fica reservado como escape para um cabeçalho de versão
  estendido, se um dia faltarem valores. O valor `0` nunca será usado (evita que
  um texto `AAAA…` seja lido como válido).
- Uma **nova variante** dentro da mesma versão (por exemplo coeficientes crus,
  `raw`, para biquads que não são RBJ) usa os valores 1 a 3 do campo de variante
  e define o próprio tamanho no documento da variante.
- Um código v1 continua decodificável por qualquer leitor futuro: leitores novos
  aceitam todas as versões anteriores.
