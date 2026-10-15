# Sondagem e qualidade — o plano técnico

Como **descobrir o que o firmware realmente faz** e como **extrair a melhor
qualidade possível** do que ele faz. Complementa [`open-questions.md`](open-questions.md)
(as incógnitas) e [`ideas.md`](ideas.md) (produto).

Revisado em 2026-10-15 com medições: veja a errata em
[`open-questions.md`](open-questions.md#errata).

> ## ⚠️ Segurança primeiro
>
> Várias sondas da seção B escrevem **coeficientes fora de faixa** ou mexem em
> bytes cujo significado não conhecemos. Se o firmware fizer *wrap* em vez de
> clamp, o resultado pode ser um filtro gritando no seu ouvido.
>
> - volume **no mínimo**;
> - fone **fora da orelha** (idealmente nem conectado — use a saída de linha para um ADC);
> - a saída do cabo para um line-in precisa de **atenuador**, senão clipa o ADC;
> - **toda sonda que grava apaga o preset atual**, e ele não pode ser lido de volta.
>   Para voltar ao de fábrica, regrave o `padrao` (os bytes estão no fixture) 🟡;
> - B3, B5, B9 e B11 são as mais arriscadas: trate como ensaio com instrumento, não com ouvido.

Marca de confiança: ✅ confirmado · 🟡 hipótese/inferência · ❌ só com o cabo.

---

# A. Análise reversa **sem** o cabo

| ID | Técnica | O que rende | Confiança |
|---|---|---|---|
| **A1** | **Minerar as ferramentas web dos fabricantes procurando `0xCB`** | Se qualquer tool web (EPZ Web Tuning, FiiO, ODM) suportar esse firmware, o bundle **contém o protocolo em claro** — inclusive os **comandos de leitura**, que são a maior lacuna do projeto | 🟡 |
| **A2** | **Extrair a imagem de OTA do app WalkPlay** | Fonte definitiva: mapa de registradores, existência de leitura, semântica do header, word length interna | 🟡 |
| **A3** | **Captura USB do app oficial** (USBPcap/Wireshark) | Mostra exatamente o que o vendor manda. Precisa do cabo | ❌ |

**A1 é o melhor ROI sem hardware.** Já temos prova de que a técnica funciona: o
AuraPEQ expõe a tabela de VID/PID e os comandos `0x4B` no bundle.

---

# B. Kit de sondagem **com** o cabo

| ID | Sonda | O que revela | Risco | Confiança |
|---|---|---|---|---|
| **B1** | **Ler `HIDDevice.collections`** | Quais reports existem (input, output, feature) e seus tamanhos. Responde "existe canal de leitura?" e **"o cabo expõe também o report `0x4B`?"** | nenhum | ✅ |
| **B2** | **`receiveFeatureReport()`** nos reports que o B1 listar | Canal **nunca explorado** em nenhum projeto que encontramos | baixo | ❌ |
| **B3** | **Comandos de leitura no padrão `0x4B`** | Enviar só comandos da classe leitura (`0x80 …`, ex. `VERSION 0x0C`) e escutar `inputreport`. **Não varrer o espaço de comandos às cegas**: um byte qualquer num report de escrita pode ser reset, DFU ou apagamento | **alto** se às cegas | 🟡 |
| **B4** | **Probe neutro** | Gravar `NEUTRAL_BANDS` (identidade exata) + pré-amp 0 e **medir**. Se a saída não for plana, o chip impõe processamento próprio. **Experimento de controle** | baixo | ✅ |
| **B5** | **Hipóteses do header** | Testar as leituras do header ([`protocol-0xcb.md`](protocol-0xcb.md#header--14-bytes)), **recalculando o CRC** a cada mudança: comprimento coerente com outra contagem de seções; byte 10 = 2 com 20 seções (EQ por canal?) | **alto** (comprimento inconsistente pode estourar buffer) | 🟡 |
| **B6** | **Mapeamento do quadro** | 8 em vez de 9 pacotes (o 9º vai vazio), fora de ordem, índice duplicado. Mostra se o firmware acumula-e-commita ou escreve incremental | médio | 🟡 |
| **B7** | **CRC como oráculo** | Gravar a curva **A** válida; depois uma curva **B ≠ A** com CRC errado. Se o som continua A, o firmware **valida** o CRC; se vira B, o CRC é decorativo | baixo | 🟡 |
| **B8** | **Precisão interna** | Perturbar uma seção sensível (baixa frequência, Q alto) por 2^k LSB, com k crescente, até a saída mudar de forma mensurável: o limiar revela truncamento interno. **Baixa prioridade**: a quantização Q27 em si é irrelevante (≤ 0,017 dB, medido) | baixo | 🟡 |
| **B9** | **Faixa / pré-amp positivo** | Empurrar \|coef\| rumo a 16 e pré-amp acima de 0 dB. Revela **clamp vs wrap vs rejeição** e o headroom interno | **alto** | 🟡 |
| **B10** | **Sonda do notch → o `FS` real** | Ver abaixo | baixo | 🟡 |
| **B11** | **Varredura de timing** | Reduzir os 16 ms/150 ms até quebrar. Mapeia o buffer e acelera a escrita; quebra = gravação parcial | **alto** | 🟡 |
| **B12** | **Modo só-RAM** | Variar os bytes `01 FF` do APPLY (e procurar um análogo de `TEMP_WRITE`). Um modo sem flash destrava o teste cego (X2) sem desgaste | médio | 🟡 |
| **B13** | **Comportamento na troca** | Gravar durante a reprodução e ouvir/medir: há estalo, mute ou transiente? Importa para o teste cego (um estalo denuncia A/B) | baixo | ❌ |

## B10 em detalhe — a sonda do `FS`

Use um **notch RBJ de verdade** (`b = [1, −2·cos w0, 1]`, normalizado): ele põe
os **zeros exatamente na circunferência unitária**, no ângulo digital
`w0 = 2π·f_definido / FS_suposto`, e produz um nulo profundo e estreito. (Um
peaking com ganho negativo **não** faz isso: os zeros ficam dentro do círculo e
a queda é finita, igual a `g`. Funciona, mas com menos contraste.)

`w0` é digital — fixado nos coeficientes. A frequência **física** do nulo depende
da taxa em que o chip executa:

```
f_medido = f_definido × (FS_real / FS_suposto)
```

### Teste 1 — absoluto

```
FS_real = FS_suposto × (f_medido / f_definido)
```

Supondo `FS_suposto = 96 kHz` e um nulo definido em 1 kHz: se aparecer em 1 kHz,
o núcleo roda a 96 kHz; se aparecer em 500 Hz, roda a 48 kHz.

### Teste 2 — relativo (mais forte, independe de suposição)

Repita com o stream a **44,1 / 48 / 96 / 192 kHz**:

| Observação | Conclusão |
|---|---|
| o nulo **não se move** | núcleo em taxa fixa, independente do stream ✅ |
| o nulo **se move proporcionalmente** | o núcleo segue a taxa do stream 🚨 |

### Urgência: rebaixada

Três implementações independentes projetam em 96 kHz (kuba, eqloader,
frost-tune). Um núcleo que seguisse o stream deslocaria a curva por 2,18× a
44,1 kHz — difícil de passar despercebido. Fixo em 96 kHz é a hipótese mais
provável. B10 continua valendo como confirmação, mas deixou de ser o "item nº 1".

### Receita

1. notch RBJ em, por exemplo, 1 kHz com Q moderado;
2. sweep de seno ou ruído com FFT de resolução fina ao redor do nulo;
3. localizar o mínimo;
4. repetir por taxa de stream.

## Medir sem equipamento de laboratório 🟡

Se o cabo tiver entrada de microfone (TRRS), dá para medir com **o próprio cabo**:
saída → atenuador (~40 dB) → capacitor de bloqueio (a entrada de microfone tem
tensão de polarização) → entrada de microfone, gravando pela mesma interface USB.
Limitações: entrada mono (um canal por vez), teto de 24 kHz se o ADC rodar a
48 kHz, e o caminho do microfone pode ter filtro passa-alta, AGC ou supressão de
ruído próprios — por isso o B4 vem antes, como calibração.

---

# C. Testes cegos — o que só o cego responde

| ID | Teste | Por que importa |
|---|---|---|
| **C1** | **JND de desvio de curva** (0,1–1 dB em banda larga e em bandas estreitas) | Diz quanto erro de ajuste é aceitável — define o critério de parada do otimizador. (Substitui o antigo "JND de 1 LSB em Q27", que não faz sentido: 1 LSB muda a resposta em ~10⁻⁷ dB.) |
| **C2** | **Pré-amp contínuo vs passo de 1 dB** | Valida se o `0xCB` é de fato melhor que o `0x4B` aqui — 1 dB de nível é audível |
| **C3** | **Ajuste perceptual vs ajuste por erro absoluto** | Preferência cega entre D4 e o AutoEQ atual. Só assim se prova que a otimização **melhora**, em vez de só *mudar* |
| **C4** | **Casar loudness entre A e B** | Obrigatório. Sem isso o teste mede volume, não qualidade |

**A ferramenta é o operador cego.** Como a escrita leva ~0,3 s, o próprio
software sorteia A/B, aplica e é o único que sabe — duplo-cego sem segundo humano.
**Dois cuidados:** cada troca grava na flash (B12) e pode estalar (B13).

---

# D. Otimizações voltadas para qualidade de áudio

| ID | Otimização | Ganho | Confiança |
|---|---|---|---|
| **D1** | **Ordenação: cortes antes dos reforços** | Medido: pico interno de −0,20 dB (ordem da referência) contra +4,79 dB (ordenado por `f`) e +9,13 dB (invertido) | ✅ (medido) |
| **D2** | **Pré-amp com margem** | `pré = −max(curva)` protege senoides; sinais de banda larga podem ultrapassar a magnitude por fase/overshoot. Reservar margem | ✅ |
| **D3** | **Otimizador ciente da quantização** | **Rebaixado**: o erro de quantização Q27 é ≤ 0,017 dB (medido). Só volta a valer se B8 mostrar truncamento interno severo | ✅ (medido) |
| **D4** | **Ajuste com peso perceptual** | ISO 226 no lugar de erro absoluto: gasta as 10 seções onde o ouvido percebe | ✅ |
| **D5** | **Penalizar bandas adjacentes opostas** | Reforço e corte colados se cancelam parcialmente: gasta 2 seções e cria ondulação | ✅ |
| **D6** | **Igualar volume por ISO 226** | A referência usa a média de 300 Hz–3 kHz; ISO 226 é o critério perceptual correto | ✅ |
| **D7** | **Proteções** | Sem reforço acima de ~16 kHz; HPF sub-sônico ~20–25 Hz; teto de Q | ✅ |
| **D8** | **Gêmeo digital do filtro** | Simular a cascata com os coeficientes quantizados e **hipóteses de aritmética interna**: resposta real + estimativa de piso de ruído e de picos internos | ✅ |
| **D9** | **A curva muda com a taxa?** | Ver B10 — urgência rebaixada | 🟡 |
| **D10** | **Bandas desligadas como identidade exata** | `OFF` ⇒ `[2^27,0,0,0,0]` no lugar de PK com `g = 0`, que mantém polos perto do círculo unitário | ✅ |

## D1 em detalhe — o que a medição mostrou

A resposta ideal não depende da ordem; o **pico interno** depende. Em cascata,
um reforço antes de um corte na mesma região faz o sinal passar por um estágio
intermediário mais alto que a saída final.

| Ordem | Pior pico interno (11 presets) |
|---|---|
| cortes primeiro (referência) | −0,20 dB |
| ordenado por frequência | +4,79 dB |
| reforços primeiro | +9,13 dB |

O risco dominante é **estouro**, não ruído: com caminhos internos de 32 bits, o
ruído de arredondamento fica muito abaixo do audível, enquanto um estouro é
clipping audível. Por isso a regra da referência é o padrão correto.
(A versão anterior deste documento tratava "cortes primeiro" como risco de ruído
— inversão de prioridade corrigida na errata.)

Refinamento possível: entre os cortes e entre os reforços, ordenar para manter o
pico acumulado mínimo, calculado pelo gêmeo digital (D8).

## D2 em detalhe — o que o pré-amp não garante

| Afirmação | Situação |
|---|---|
| "pré = −max(curva) ⇒ a saída não passa de 0 dBFS" | vale para **senoides** |
| "…e nunca estoura internamente" | **falso**: no `harman` o pico interno (−0,20 dB) é maior que o da saída (−1,05 dB) |
| "…e nunca clipa com música" | **falso**: sinais de banda larga podem ter picos acima da magnitude por causa da fase |

---

# E. Prioridade

| Ordem | O que | Por quê |
|---|---|---|
| 1 | **B1** (`collections`) | nenhum risco; pode destravar o `0x4B` inteiro (leitura, versão, slots) |
| 2 | **B4** (neutro) | linha de base — sem ela nada mais é interpretável |
| 3 | **B7** (CRC) | define se erro de transmissão é rejeitado |
| 4 | **B10** (FS) | confirmação; urgência rebaixada |
| 5 | **A1** (minerar tools web) | pode resolver a leitura sem hardware |
| 6 | **B12, B13** | pré-requisitos do teste cego |
| 7 | **B6, B5** | mapeamento do quadro e do header |
| 8 | **D4, D6, D7** | qualidade e proteção |
| 9 | **B2, B3** | caça à leitura, só com comandos de leitura |
| 10 | **C1–C3** | validação cega |

**Se só der para fazer uma coisa:** `B1 → B4 → B7`, nessa ordem.
