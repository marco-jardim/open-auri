# Sondagem e qualidade — o plano técnico

Como **descobrir o que o firmware realmente faz** e como **extrair a melhor
qualidade possível** do que ele faz. Complementa [`open-questions.md`](open-questions.md)
(as incógnitas) e [`ideas.md`](ideas.md) (produto).

> ## ⚠️ Segurança primeiro
>
> Várias sondas da seção B escrevem **coeficientes fora de faixa**. Se o firmware
> fizer *wrap* em vez de clamp, o resultado pode ser um filtro gritando no seu
> ouvido.
>
> - volume **no mínimo**;
> - fone **fora da orelha** (idealmente nem conectado — use a saída de linha para um ADC);
> - a saída do cabo para um line-in precisa de **atenuador**, senão clipa o ADC;
> - B9 e B11 são as mais arriscadas: trate como ensaio com instrumento, não com ouvido.

Marca de confiança: ✅ confirmado · 🟡 hipótese/inferência · ❌ só com o cabo.

---

# A. Análise reversa **sem** o cabo

| ID | Técnica | O que rende | Confiança |
|---|---|---|---|
| **A1** | **Minerar as ferramentas web dos fabricantes procurando `0xCB`** | Se qualquer tool web (EPZ Web Tuning, FiiO, ODM) suportar esse firmware, o bundle **contém o protocolo em claro** — inclusive os **comandos de leitura**, que são a maior lacuna do projeto | 🟡 |
| **A2** | **Extrair a imagem de OTA do app WalkPlay** | Fonte definitiva: mapa de registradores, existência de leitura, semântica do header, word length interna | 🟡 |
| **A3** | **Captura USB do app oficial** (USBPcap/Wireshark) | Mostra exatamente o que o vendor manda. Precisa do cabo | ❌ |

**A1 é o melhor ROI de todo o documento** e não precisa de hardware. Já temos
prova de que a técnica funciona: o AuraPEQ expõe a tabela de VID/PID e os
comandos `0x4B` no bundle.

---

# B. Kit de sondagem **com** o cabo

| ID | Sonda | O que revela | Confiança |
|---|---|---|---|
| **B1** | **Ler o HID report descriptor** | Responde "existe canal de leitura?" **antes** de qualquer fuzzing: tamanhos de input/feature report, usage pages | ✅ |
| **B2** | **`receiveFeatureReport()`** | Canal **nunca explorado** em nenhum projeto que encontramos | ❌ |
| **B3** | **Varredura do espaço de comando nos input reports** | Enviar `0xCB` + byte candidato (`0x00`–`0xFF`) e escutar `inputreport`. Destrava pull/verify/backup | 🟡 |
| **B4** | **Probe "flat" (identidade)** | Escrever 10 biquads identidade + preamp 0 e **medir**. Se a saída não for plana, o chip impõe processamento próprio. **Experimento de controle** — sem ele toda medição seguinte é ambígua | ✅ |
| **B5** | **Mapeamento por bit-flip no header** | Mutar cada byte do `"EQ1#"` + cauda e ver se a gravação ainda vale. Separa *magic* de *parâmetro* — pode revelar um campo que **não estamos usando** | 🟡 |
| **B6** | **Mapeamento do quadro** | 8 em vez de 9 pacotes, fora de ordem, índice duplicado. Mostra se o firmware acumula-e-commita ou escreve incremental — e se **escrita parcial** existe | 🟡 |
| **B7** | **CRC como oráculo** | Curva válida vs mesma curva com CRC errado. Se o som não muda, o firmware **valida** o CRC; se muda, o CRC é decorativo | 🟡 |
| **B8** | **Sonda de LSB** | Duas curvas diferindo por 1 LSB em Q27. Se a saída difere, a precisão interna é ≥ Q27. Mapeia a precisão **efetiva** | 🟡 |
| **B9** | **Sonda de faixa / preamp positivo** | Empurrar \|coef\| rumo a 16 e preamp acima de 0 dB. Revela **clamp vs wrap vs rejeição** e o headroom interno ⚠️ | 🟡 |
| **B10** | **🎯 Sonda do notch → o `FS` real** | Ver abaixo. Um sweep dá a taxa interna com precisão | 🟡 |
| **B11** | **Varredura de timing** | Reduzir os 16 ms/150 ms até quebrar. Mapeia o buffer e acelera a escrita ⚠️ | 🟡 |

## B10 em detalhe — a sonda que contamina todo o resto

Um filtro com ganho muito negativo coloca **zeros na circunferência unitária**.
O zero fica no *ângulo digital* `w0 = 2π·f_definido / FS_suposto` — os
coeficientes são digitais, então `w0` **não** depende do que o chip faz depois.
Mas a frequência **física** onde o null aparece depende da taxa em que o chip
executa:

```
f_medido = f_definido × (FS_real / FS_suposto)
```

### Teste 1 — absoluto

Um único caso dá o `FS` real:

```
FS_real = FS_suposto × (f_medido / f_definido)
```

Supondo `FS_suposto = 96 kHz` e um null definido em 1 kHz: se aparecer em 1 kHz,
o core roda a 96 kHz. Se aparecer em 500 Hz, o core roda a 48 kHz.

### Teste 2 — relativo (mais forte, e não depende de suposição)

Repita o mesmo ensaio com o stream a **44,1 / 48 / 96 / 192 kHz**:

| Observação | Conclusão |
|---|---|
| o null **não se move** | o core roda em taxa fixa, independente do stream ✅ |
| o null **se move proporcionalmente** | o core segue a taxa do stream 🚨 |

### Por que isso é o item nº 1 de qualidade

Projetamos em 96 kHz. Se o core seguir a taxa do stream, um conteúdo a 44,1 kHz
recebe filtros **completamente diferentes** — e **a curva que o usuário aprovou
não é a que ele ouve**. Nenhum projeto aberto que encontramos testa isso.

### Receita

1. peaking com ganho bem negativo (ex.: `−40 dB`) e Q moderado — null profundo e localizável;
2. sweep de seno ou ruído com FFT de resolução fina ao redor do null;
3. ajustar a frequência do sweep até achar o mínimo;
4. repetir por taxa de stream.

---

# C. Testes cegos — o que só o cego responde

| ID | Teste | Por que importa |
|---|---|---|
| **C1** | **JND de 1 LSB em Q27** | Decide se vale investir em design quantization-aware ou se Q27 é folgado. Resposta **empírica**, não teórica |
| **C2** | **Preamp contínuo vs passo de 1 dB** | Valida se o `0xCB` é de fato melhor que o `0x4B` aqui — 1 dB de nível é audível |
| **C3** | **Otimizador quantization-aware vs comum** | Preferência cega. Só assim se prova que a otimização **melhora**, em vez de só *mudar* |
| **C4** | **Casar loudness entre A e B** | Obrigatório. Sem isso o teste mede volume, não qualidade |

**A ferramenta é o operador cego.** Como a escrita leva ~0,3 s, o próprio
software sorteia A/B, aplica e é o único que sabe — duplo-cego sem segundo humano.

---

# D. Otimizações voltadas para qualidade de áudio

O protocolo dá alavancas que ninguém usa.

| ID | Otimização | Ganho | Confiança |
|---|---|---|---|
| **D1** | **Ordenação das seções** | Bandas em série **comutam** ⇒ nós escolhemos a ordem. Em ponto fixo a ordem controla headroom interno e ruído | ✅ |
| **D2** | **Preamp antes das bandas está certo** | Se preamp = `−max(boost)` e é aplicado primeiro, o pico depois das bandas fica em 0 dBFS: **nunca estoura internamente** | 🟡 |
| **D3** | **Otimizador quantization-aware** | Projetar **sob a restrição** em vez de projetar ideal e arredondar | ✅ |
| **D4** | **Fitting com peso perceptual** | ISO 226 no lugar de erro absoluto: gasta as 10 seções onde o ouvido percebe | ✅ |
| **D5** | **Penalizar bandas adjacentes opostas** | Boost e corte colados se cancelam parcialmente: gasta 2 seções e cria ripple | ✅ |
| **D6** | **Loudness matching por ISO 226** | A referência usa a média de 300 Hz–3 kHz; ISO 226 é o critério perceptual correto | ✅ |
| **D7** | **Guardrails de proteção** | Sem boost acima de ~16 kHz; HPF sub-sônico ~20–25 Hz; teto de Q | ✅ |
| **D8** | **Gêmeo digital do filtro** | Simular a cascata em ponto fixo com os coeficientes **quantizados**: resposta real + estimativa de piso de ruído | ✅ |
| **D9** | **A curva muda com a taxa?** | Ver B10. 🚨 | 🟡 |

## D1 em detalhe — o ganho que sai de graça

Em cascata de ponto fixo, a ordem das seções controla dois riscos:

| Ordem | Risco |
|---|---|
| **cut** cedo + boost depois | perde bits e **amplifica o ruído de quantização** |
| boost cedo + cut depois | **overflow interno** |

Heurística: ordenar para manter o **ganho acumulado perto de 1** ao longo da
cadeia; no empate, seções **menos ressonantes primeiro**. É otimização clássica
de cascata IIR — e existe de graça aqui porque controlamos a ordem no blob.

## D3 em detalhe — projeto sob restrição

O fluxo atual é *projetar ideal → arredondar*. O correto é **buscar os inteiros
que minimizam o erro entre a resposta ideal e a resposta dos coeficientes
quantizados**. Isso permite:

- trocar uma seção profunda por duas rasas;
- evitar coeficientes mal condicionados;
- e sobretudo **avisar quando a curva é inatingível**, em vez de mentir no gráfico.

---

# E. Prioridade

| Ordem | O que | Por quê |
|---|---|---|
| 1 | **B4** (flat) | linha de base — sem ela nada mais é interpretável |
| 2 | **B1** (descriptor) | responde "existe leitura?" sem risco |
| 3 | **B10** (FS) | contamina tudo: curva, quantização, projeto |
| 4 | **A1** (minerar tools web) | pode resolver a leitura sem hardware |
| 5 | **B5, B6, B7** | mapeamento do header e do quadro |
| 6 | **D1, D7** | qualidade e proteção, baratos |
| 7 | **D3, D4, D6** | qualidade, mais esforço |
| 8 | **B2, B3** | caça à leitura |
| 9 | **C1–C3** | validação cega das otimizações |

**Se só der para fazer uma coisa:** `B4 → B1 → B10`, nessa ordem.
