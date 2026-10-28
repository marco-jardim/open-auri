# Sondagem e qualidade: o plano técnico

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
> - fone **fora da orelha** (idealmente nem conectado: use a saída de linha para um ADC);
> - a saída do cabo para um line-in precisa de **atenuador**, senão clipa o ADC;
> - **toda sonda que envia dados substitui a curva ativa**; com commit, sobrescreve
>   o preset persistido, que não pode ser lido de volta.
>   Para voltar ao de fábrica, regrave o `padrao` (os bytes estão no fixture) 🟡;
> - B3, B5, B9 e B11 são as mais arriscadas: trate como ensaio com instrumento, não com ouvido.

Marca de confiança: ✅ confirmado · 🟡 hipótese/inferência · ❌ só com o cabo.

---

# A. Análise reversa **sem** o cabo

| ID | Técnica | O que rende | Confiança |
|---|---|---|---|
| **A1** | **Minerar as ferramentas web dos fabricantes procurando `0xCB`** | Se qualquer tool web (EPZ Web Tuning, FiiO, ODM) suportar esse firmware, o bundle **contém o protocolo em claro**, inclusive os **comandos de leitura**, que são a maior lacuna do projeto | 🟡 |
| **A2** | **Extrair a imagem de OTA do app WalkPlay** | Fonte definitiva: mapa de registradores, existência de leitura, semântica do header, word length interna | 🟡 |
| **A3** | **Captura USB do app oficial** (USBPcap/Wireshark) | Mostra exatamente o que o vendor manda. Precisa do cabo | ✅ (feita da página oficial em 2026-10-28; ver F) |

**A1 é o melhor ROI sem hardware.** Já temos prova de que a técnica funciona: o
AuraPEQ expõe a tabela de VID/PID e os comandos `0x4B` no bundle.

---

# B. Kit de sondagem **com** o cabo

| ID | Sonda | O que revela | Risco | Confiança |
|---|---|---|---|---|
| **B1** | **Ler `HIDDevice.collections`** | Quais reports existem (input, output, feature) e seus tamanhos. Responde "existe canal de leitura?" e **"o cabo expõe também o report `0x4B`?"** | nenhum | ✅ |
| **B2** | **`receiveFeatureReport()`** nos reports que o B1 listar | Canal **nunca explorado** em nenhum projeto que encontramos | baixo | ✅ (feito: sem feature reports) |
| **B3** | **Comandos de leitura no padrão `0x4B`** | Enviar só comandos da classe leitura (`0x80 …`, ex. `VERSION 0x0C`) e escutar `inputreport`. **Não varrer o espaço de comandos às cegas**: um byte qualquer num report de escrita pode ser reset, DFU ou apagamento | **alto** se às cegas | 🟡 |
| **B4** | **Probe neutro** | Medir `NEUTRAL_BANDS` (identidade exata) + pré-amp −0,5 dB como controle e comparar com PK. Reprodutibilidade e resposta diferencial medidas; planicidade absoluta não medida (ver F) | baixo | ✅ |
| **B5** | **Hipóteses do header** | Testar as leituras do header ([`protocol-0xcb.md`](protocol-0xcb.md#header-14-bytes)), **recalculando o CRC** a cada mudança: comprimento coerente com outra contagem de seções; byte 10 = 2 com 20 seções (EQ por canal?) | **alto** (comprimento inconsistente pode estourar buffer) | 🟡 |
| **B6** | **Mapeamento do quadro** | 8 em vez de 9 pacotes (o 9º vai vazio), fora de ordem, índice duplicado. Mostra se o firmware acumula-e-commita ou escreve incremental | médio | 🟡 |
| **B7** | **CRC como oráculo** | Gravar a curva **A** válida; depois uma curva **B ≠ A** com CRC errado. Se o som continua A, o firmware **valida** o CRC; se vira B, o CRC é decorativo | baixo | ✅ |
| **B8** | **Precisão interna** | Perturbar uma seção sensível (baixa frequência, Q alto) por 2^k LSB, com k crescente, até a saída mudar de forma mensurável: o limiar revela truncamento interno. **Baixa prioridade**: a quantização Q27 em si é irrelevante (≤ 0,017 dB, medido) | baixo | 🟡 |
| **B9** | **Faixa / pré-amp positivo** | Empurrar \|coef\| rumo a 16 e pré-amp acima de 0 dB. Revela **clamp vs wrap vs rejeição** e o headroom interno. O codec recusa pré-amp positivo: essa parte exige montar o blob à mão, fora do codec | **alto** | 🟡 |
| **B10** | **Sonda do notch → o `FS` real** | Ver abaixo; medida com PK negativo (seção F) | baixo | ✅ (96 kHz com stream a 48 kHz) |
| **B11** | **Varredura de timing** | Reduzir os 16 ms/150 ms até quebrar. Mapeia o buffer e acelera a escrita; quebra = gravação parcial | **alto** | 🟡 |
| **B12** | **Modo só-RAM** | Omitir o commit: os 9 reports aplicam ao vivo, sem persistir. Variação de `01 FF` não testada | médio | ✅ |
| **B13** | **Comportamento na troca** | Gravar durante a reprodução e ouvir/medir: há estalo, mute ou transiente? Importa para o teste cego (um estalo denuncia A/B) | baixo | ✅ (com ressalva; ver F) |

## B10 em detalhe: a sonda do `FS`

Use um **notch RBJ de verdade** (`b = [1, −2·cos w0, 1]`, normalizado): ele põe
os **zeros exatamente na circunferência unitária**, no ângulo digital
`w0 = 2π·f_definido / FS_suposto`, e produz um nulo profundo e estreito. (Um
peaking com ganho negativo **não** faz isso: os zeros ficam dentro do círculo e
a queda é finita, igual a `g`. Funciona, mas com menos contraste.)

`w0` é digital, fixado nos coeficientes. A frequência **física** do nulo depende
da taxa em que o chip executa:

```
f_medido = f_definido × (FS_real / FS_suposto)
```

### Teste 1: absoluto

```
FS_real = FS_suposto × (f_medido / f_definido)
```

Supondo `FS_suposto = 96 kHz` e um nulo definido em 1 kHz: se aparecer em 1 kHz,
o núcleo roda a 96 kHz; se aparecer em 500 Hz, roda a 48 kHz.

### Teste 2: relativo (mais forte, independe de suposição)

Repita com o stream a **44,1 / 48 / 96 / 192 kHz**:

| Observação | Conclusão |
|---|---|
| o nulo **não se move** | núcleo em taxa fixa, independente do stream ✅ |
| o nulo **se move proporcionalmente** | o núcleo segue a taxa do stream 🚨 |

### Urgência: rebaixada

Três implementações independentes projetam em 96 kHz (kuba, eqloader,
frost-tune). Um núcleo que seguisse o stream deslocaria a curva por 2,18× a
44,1 kHz, algo difícil de passar despercebido. Fixo em 96 kHz é a hipótese mais
provável. B10 continua valendo como confirmação, mas deixou de ser o "item nº 1".

**Atualização 2026-10-28:** B10 confirmou 96 kHz com stream a 48 kHz por PK
negativo (ver F). A repetição em outras taxas de stream continua não executada.

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
ruído próprios. Por isso o B4 vem antes, como calibração.

---

# C. Testes cegos: o que só o cego responde

| ID | Teste | Por que importa |
|---|---|---|
| **C1** | **JND de desvio de curva** (0,1–1 dB em banda larga e em bandas estreitas) | Diz quanto erro de ajuste é aceitável e define o critério de parada do otimizador. (Substitui o antigo "JND de 1 LSB em Q27", que não faz sentido: 1 LSB muda a resposta em ~10⁻⁷ dB.) |
| **C2** | **Pré-amp contínuo vs passo de 1 dB** | Valida se o `0xCB` é de fato melhor que o `0x4B` aqui: 1 dB de nível é audível |
| **C3** | **Ajuste perceptual vs ajuste por erro absoluto** | Preferência cega entre D4 e o AutoEQ atual. Só assim se prova que a otimização **melhora**, em vez de só *mudar* |
| **C4** | **Casar loudness entre A e B** | Obrigatório. Sem isso o teste mede volume, não qualidade |

**A ferramenta é o operador cego.** Como a escrita leva ~0,3 s, o próprio
software sorteia A/B, aplica e é o único que sabe: duplo-cego sem segundo humano.
**Dois cuidados:** usar envio sem commit para evitar flash (B12, viabilidade
medida; ainda não implementado) e respeitar os limites da medição de transientes
(B13; ver F).

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
| **D9** | **A curva muda com a taxa?** | Ver B10 (urgência rebaixada) | 🟡 |
| **D10** | **Bandas desligadas como identidade exata** | `OFF` ⇒ `[2^27,0,0,0,0]` no lugar de PK com `g = 0`, que mantém polos perto do círculo unitário | ✅ |

## D1 em detalhe: o que a medição mostrou

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
(A versão anterior deste documento tratava "cortes primeiro" como risco de ruído,
uma inversão de prioridade corrigida na errata.)

Refinamento possível: entre os cortes e entre os reforços, ordenar para manter o
pico acumulado mínimo, calculado pelo gêmeo digital (D8).

## D2 em detalhe: o que o pré-amp não garante

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
| 2 | **B4** (neutro) | linha de base: sem ela nada mais é interpretável |
| 3 | **B7** (CRC) | define se erro de transmissão é rejeitado |
| 4 | **B10** (FS) | confirmação; urgência rebaixada |
| 5 | **A1** (minerar tools web) | pode resolver a leitura sem hardware |
| 6 | **B12, B13** | pré-requisitos do teste cego |
| 7 | **B6, B5** | mapeamento do quadro e do header |
| 8 | **D4, D6, D7** | qualidade e proteção |
| 9 | **B2, B3** | caça à leitura, só com comandos de leitura |
| 10 | **C1–C3** | validação cega |

**Se só der para fazer uma coisa:** `B1 → B4 → B7`, nessa ordem.

---

# F. Registro de resultados com o cabo

## 2026-10-28: primeiro cabo real

Cabo "Kuba Auri", VID `0x3302` / PID `0x8902`, série `33028902260831`,
interface HID `mi_03`. Windows 11, Edge 156 (Chromium) com WebHID; USBPcap
1.5.4.0 e Wireshark/tshark 4.6.9.

| Sonda | Situação | Resultado |
|---|---|---|
| **B1** | ✅ feita | Uma collection: usage page `0x0C`, usage `0x01` (Consumer Control). Input report `1`: botões de consumo (Play/Pause `0x0C00CD`, Vol+ `0x0C00E9`, Vol− `0x0C00EA`, `0x0C00CF`, Menu `0x0C0040`, Próxima `0x0C00B5`, Anterior `0x0C00B6`, Mudo `0x0C00E2`, Flash de telefonia `0x0B0021`) e padding. Input report `0xCB`: 31 bytes, uso vendor `0xFF000003`. Output report `0xCB`: 31 bytes, uso vendor `0xFF000002`. **Nenhum feature report. Nenhum report `0x4B`** |
| **B2** | ✅ feita | `receiveFeatureReport(0)`, `(1)` e `(0xCB)` rejeitam com `NotAllowedError`. Escuta passiva de 10 s: nenhum input report |
| Wire format | ✅ feita | 13 gravações (11 pela página oficial, `padrao` e Neutro pelo open-auri) capturadas no fio e comparadas byte a byte. Ver [`verification.md`](verification.md#validação-no-fio-com-o-cabo-real) |
| **B3** | não executada | Decisão pendente: não há comando de leitura documentado para o `0xCB`. Os comandos de leitura do `0x4B` (devicePEQ, AuraPEQ) existem, mas este cabo não expõe o report `0x4B` |
| **B4** | ✅ feita | Neutro reproduzível; PK medido concorda com `magnitudeDb` em ~0,5 dB (abaixo) |
| **B7** | ✅ feita | CRC corrompido rejeitado silenciosamente; CRC correto aplica a curva |
| **B10** | ✅ feita | DSP a 96 kHz com stream do host a 48 kHz; resolução de 1/6 de oitava + simetria |
| **B12** | ✅ feita | 9 reports sem commit aplicam só em RAM; replug restaura a curva persistida |
| **B12b** | ✅ feita | Reports 0..6 ou 0..7 (com CRC) não aplicam; 0..8 aplica, inclusive após sequência parcial |
| **B12c** | ✅ com ressalva | Estado sem reação a prévias observado uma vez após 1000 + 50 aplicações; replug recuperou. Não reproduzido em ≈1065 aplicações adicionais; gatilho desconhecido |
| **B13** | ✅ com ressalva | Rampa suave de ~15 ms, sem energia de clique audível nem intervalo de mute no ensaio |
| **B5, B6, B8, B9, B11** | não executadas | Permanecem pendentes |

O input report `0xCB` (uso `0xFF000003`) é o único candidato a canal de
leitura. Nada chegou por ele durante as gravações nem na escuta passiva.

### Medição acústica (mesmo dia)

**Método:** saída do fone Kuba Auri → microfone HyperX QuadCast S, concha
fixada contra o microfone, volume ~40–50%. WebAudio no navegador a 48 kHz no
Windows, com `echoCancellation`, `noiseSuppression` e `autoGainControl`
desligados. Senoides em degraus de 1/6 de oitava, de 707 Hz a 8 kHz, 2 passagens
por ponto; pico do tom na FFT de 32768. SNR de 40–60 dB a partir de 1 kHz;
abaixo de ~1 kHz, acoplamento acústico fraco demais (<30 dB).

Alternância A/B ×3 (A = Neutro, B = curva de teste), comparando com bandas de
referência distantes (6,3–8 kHz). Escritas pelo console do navegador com os
mesmos frames do codec: 9 reports, intervalos de 16 ms, espera de 150 ms e
commit; 2,1 s entre escritas, salvo a omissão do commit em B12 e os ensaios
B12b/B12c descritos abaixo. Curvas
classificadas como `standard` por `src/safety/classify.mjs`: PK 2000 Hz −12 dB
Q3, pré-amp −0,5 dB (CRC `0x3D48`), e PK 5000 Hz −12 dB Q3, mesmo pré-amp
(CRC `0xBE68`). Uma tentativa inicial foi invalidada por movimento do conjunto
fone/mic (dispersão de ±15–25 dB nas repetições). **Lição: fixar o transdutor e
manter o volume constante.**

**B4:** B−A para PK 2 kHz, média dos 3 ciclos:

| Hz | Medido (dB) | `magnitudeDb` (dB) |
|---|---|---|
| 1000 | −0,8 | −0,7 |
| 1414 | −2,5 | −2,5 |
| 1782 | −7,7 | ≈−7,5 |
| 2000 | −12,4 | −12,0 |
| 2245 | −7,5 | ≈−7,5 |
| 2828 | −2,5 | −2,5 |
| 4000 | −0,5 | −0,7 |
| 5657 | −0,1 | −0,3 |
| 8000 | −0,1 | −0,1 |

Concordância em ~0,5 dB. A curva entra em efeito imediatamente (≤ ~1,5 s,
sem replug). Neutro reproduzível em ±0,5 dB entre 4 medições; trata-se de
resposta diferencial, não de planicidade acústica absoluta do fone.

**B10:** vales centrados em 2000 Hz e 5040 Hz, onde projetados com
`SAMPLE_RATE = 96000`; vizinhos simétricos no PK 2 kHz (−7,7/−7,5 dB).
Confirma DSP a 96 kHz com host a 48 kHz, na resolução de 1/6 de oitava +
simetria. PK 5 kHz com CRC correto: 5040 Hz −12,4 dB; 4490 Hz −7,5 dB;
5657 Hz −7,4 dB; 4000 Hz −4,2 dB contra a linha de base (previstos:
4000 Hz −4,4 dB e 5657 Hz −7,4 dB).

**B7:** com PK 2 kHz armazenado, enviou-se PK 5 kHz com o último byte do CRC
corrompido (`XOR 0xFF`, report 7 byte 10). A resposta permaneceu PK 2 kHz,
medida duas vezes; a mesma curva com CRC correto aplicou normalmente.
**O firmware valida o CRC; a rejeição é silenciosa**, sem input report.

**B13:** troca Neutro → PK 2 kHz durante tom de 2 kHz: queda de ~10 dB numa
rampa suave de ~15 ms, sem energia de clique audível e sem intervalo de mute.
Ressalvas: a sensibilidade do microfone em altas frequências limita a detecção
de cliques muito curtos só em HF; o ScriptProcessor perdeu ~17% dos frames,
impedindo medir o alinhamento temporal absoluto dentro da escrita.

**B12:** com PK 2 kHz já commitado, os 9 reports de Neutro **sem** o commit
`01 65 00 01 FF` tornaram o som neutro imediatamente (2 medições). Após
desconectar/reconectar, voltou PK 2 kHz (2000 Hz −12,8 dB contra a referência,
3 passagens). **Os reports de dados aplicam ao vivo, de forma volátil; o commit
persiste na flash.** Não se variaram os bytes `01 FF` (desnecessário para essa
conclusão). Viabiliza modo sem flash, X2 no cabo e teste cego no cabo. O modo
sem flash está **implementado no app web: "Ouvir no cabo", #62** (plano
`docs/plans/2026-10-28-modo-sem-flash-plano.md`); X2 e teste cego no cabo seguem
não implementados.

Até esse ponto: ~12 escritas com commit na bancada + 13 na captura, além de
1 envio só de dados. Estado então: **Padrão Auri regravado com commit**, bytes
oficiais, CRC `0x1970`. Ainda não feitos: B3 (sem leitura `0xCB` documentada),
B5, B6, B8, B9 e B11.

### B12b/B12c: sequências parciais e resistência (mesmo dia)

Mesmo cabo e método acústico (QuadCast S, senoides em degraus). Métrica:
nível em 2 kHz relativo à média de 7127/8000 Hz; Neutro ≈ −6 a −10 dB,
PK 2 kHz −12 dB Q3 ≈ −18 a −21 dB. Envios ao vivo **sem commit**.

**B12b ✅:** com Neutro commitado, PK 2 kHz só com reports 0..6 não mudou
o som (−7,17 dB vs −6,95 dB neutro); 0..7, incluindo CRC, também não
(−7,77 dB). A sequência completa 0..8 aplicou (−16,3 dB nessa rodada),
inclusive após uma parcial. **A curva só entra quando chega o report 8;
uma sequência interrompida antes dele é ignorada.**

**B12c — rodada 1 ✅:** 1000 aplicações alternando Neutro/PK 2 kHz, com
intervalos de 16 ms + espera de 150 ms (~2,4/s, 11 min), mais 50 seguidas
sem essa espera; **0 erros de envio**. Depois, o cabo parou de reagir às
prévias: 5 aplicações alternando PK/Neutro e uma de PK 5 kHz não mudaram
o som. Uma escrita completa **com commit** (Neutro) aplicou imediatamente,
mas as prévias seguintes continuaram sem reação. Desconectar/reconectar
restaurou o funcionamento. A checagem da curva commitada antes dessa rodada
foi perdida: o commit de diagnóstico a sobrescreveu com Neutro.

**B12c — rodada 2 ✅ (após replug):** 1005 aplicações com timing normal em
5 lotes de ~200; a checagem após cada lote confirmou prévias funcionando
(Neutro −6,4…−9,9 dB vs PK −18,3…−21,6 dB, nos 5). Mais 10 e 50 aplicações
seguidas sem a espera: continuou aplicando (última = PK, −18,7/−20,0 dB),
assim como aplicações normais depois. Uma curva ao vivo permaneceu sem
mudança após 45 s ocioso (−19,05 → −19,0 dB).

**B12c — integridade da curva commitada ✅:** após a rodada 2 e testes
posteriores, ≈1100 aplicações ao vivo (normais e seguidas sem espera), **sem
nenhum commit desde o Neutro de diagnóstico da rodada 1**, desconectar/reconectar
restaurou exatamente esse Neutro. Nível em 2 kHz relativo a 7127/8000 Hz,
respectivamente: após replug, −1,95/−1,5 dB; Neutro ao vivo logo depois,
−2,2/−1,35 e −1,55/−1,45 dB; PK 2 kHz −12 dB ao vivo, −13,6/−13,25 dB.
**A curva commitada sobreviveu às ≈1100 prévias.** O conjunto acústico havia
mudado desde as medições anteriores desta seção: a comparação é com as
referências ao vivo da mesma sessão, não com os valores absolutos anteriores.

**Limite:** o estado travado da rodada 1 **não foi reproduzido** em ≈1065
aplicações adicionais, inclusive rápidas; gatilho desconhecido. Diferenças
da rodada 1: fluxo ininterrupto de 11 min, sem áudio tocando durante ele,
aba oficial da Kuba também com o dispositivo aberto; não se isolou a causa.

**Mitigações adotadas no plano da funcionalidade:** como não há ack, a UI deve
orientar a desconectar/reconectar se a prévia parar de mudar o som; “Salvar”
sempre envia os 9 reports + commit (funcionou no estado travado); cadência
de prévias ≥300 ms e contador próprio de aplicações ao vivo.
