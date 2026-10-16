# Limites v2 — gate do envelope observado
Data: 2026-10-15T22:46:44.799Z; Node v24.21.0. Artefatos: [gate.mjs](gate.mjs), [limites-v2.json](limites-v2.json).
**Conclusão:** ampliar experimentalmente os tipos e parâmetros com gate em coeficientes quantizados é defensável como política conservadora de similaridade; **não é prova de segurança do firmware**. Os 11 presets oficiais passam. Foram avaliadas **17,371,200** combinações distintas e **4,772,277** pontos adicionais das caixas suaves, sem HID.
O chip não recebe um byte de tipo, mas máximos marginais de coeficientes + raio dos polos + picos senoidais não limitam estados internos, norma de resposta ao impulso, limit cycles, transientes, sinais de banda larga ou aritmética desconhecida. “Passa no gate” não significa “já foi gravado pela Kuba”.

## 1. Evidência de biquad não restrito a PK
Para PK, `b1 == a1`; também `b0+b2 == 1+a2` antes da quantização. Nos **106 PK** oficiais, a primeira igualdade é exata nos inteiros Q27; a segunda tem resíduo máximo de 1 LSB.
| LS oficial / estágio | b1−a1 (LSB Q27) | b1−a1 (float quantizado) | (b0+b2)−(1+a2), LSB |
|---|---:|---:|---:|

| basshead / 10 | 22676 | 0.00016894936561584473 | 22676 |
| analitico / 1 | -4593 | -0.00003422051668167114 | -4594 |
| referencia / 1 | -9859 | -0.00007345527410507202 | -9858 |
| harman / 1 | -7407 | -0.000055186450481414795 | -7407 |

Os **4 LS** quebram ambas as simetrias PK por milhares de LSB: não são diferenças de arredondamento. Portanto os payloads oficiais exercitam numeradores que não são os de PK, com `b1` independente de `a1`. Isso é forte evidência de suporte a biquads gerais no layout conhecido, não uma demonstração de aceitação de qualquer conjunto de coeficientes.
Cuidado adicional: todos os PK/LS oficiais ainda têm ganho unitário em Nyquist, com resíduo máximo de 1 LSB na identidade do numerador/denominador em z=−1. HS/LP/HP e OFF introduzem combinações/simetrias diferentes. A implementação genérica é plausível pelo formato, mas não foi inspecionada nem medida no firmware.

## 2. Gate puro e limiares exatos
`gate(eqBands, preampDb) → { ok, reasons, metrics }`, exportado de `gate.mjs`. Sem HID, DOM, I/O por chamada ou mutação dos argumentos. Usa `encodePayload`, `encodeSection`, palavras Q27 e pré Q23 reais.
| a — posição no fio | Limite absoluto em LSB | Limite normalizado exato |
|---|---:|---:|

| b0 | 176145720 | 1.3123878836631775 |
| b2 | 133967223 | 0.9981335923075676 |
| -a1 | 268076748 | 1.9973274171352386 |
| b1 | 268076748 | 1.9973274171352386 |
| -a2 | 133859379 | 0.9973300918936729 |

| Verificação | Limite exato | Origem |
|---|---:|---|
| b — raio Q27 | 0.99986846753918 | maior raio observado |
| c — pico individual DC–48 kHz | 9.200000050722664 dB | maior pico Q27 individual |
| d — qualquer prefixo, pré incluído, 20 Hz–20 kHz | -0.20368875272918074 dB | pior prefixo oficial Q27/Q23 |
| e — saída 20 Hz–20 kHz | -0.47087539615209006 dB | pior saída oficial Q27/Q23 |
| e — saída DC–48 kHz | 2.5000638697363913 dB | Basshead em DC |
| f — validação do codec | `encodePayload` não pode lançar | 10 seções, tipos, finitude, estabilidade Q27, int32 etc. |
| g — pré nominal | −25,5…−0,5 dB | teto oficial; piso de usabilidade S1 |
Os limites vêm de `envelope.json`, usando os **máximos quantizados**, não os valores float arredondados −0,2037 / −0,4709 / +9,2. Tolerâncias explícitas somente de cálculo: **1e−8 dB** e **2e−15** no raio; coeficientes são comparados em inteiros, sem folga.
**(c) não é redundante.** PK 1 kHz / +12 dB / Q4, pré −12,6 dB passa (a), (b), (d), (e), (f), (g), mas falha só em (c). Pré/cancelamentos poderiam ocultar um pico individual maior. Mantemos (c) como política de similaridade independente; não afirmamos que ganho da seção isolada seja, por si só, a carga de acumulador no circuito.
**Pré:** qualquer redução de ganho não nula é atenuação na aritmética ideal; o piso −25,5 dB é compatibilidade/usabilidade do S1, não limite medido do chip. Nesse piso o Q23 ainda é **445338**, longe de zero. Teto nominal −0,5 dB vira **7919357**, ou -0.49999958245018883 dB quantizados. Mais negativo reduz picos dos prefixos, mas não resolve coeficientes/polos/pico individual reprovados.

## 3. Método e região viável (uma seção + nove OFF)
Grade: **168 frequências** log 20–20.000 Hz (inclui âncoras), **88 Qs** log 0,1–20, **391 ganhos** −24…+15 dB em 0,1 dB. LP/HP não têm ganho: cada f/Q foi calculado uma vez; repetir 391 rótulos ignorados seria redundante.
Picos individuais: extremos analíticos da razão de dois polinômios quadráticos em `t=sin²(ω/2)`, avaliando extremos e raízes reais da derivada; resposta avaliada na forma estável do codec. Diferença máxima contra os 110 picos Q27 do estudo anterior: **5.329070518200751e-15 dB**.
Cascatas/prefixos: mesma grade de 16.384 intervalos log + refinamento local do estudo anterior. Isso reproduz os valores publicados, mas não é certificação por aritmética intervalar.
Pré automático = maior **palavra Q23** permitida pelo teto nominal e por (d)/(e). Se o limite é P: escolher `min(preampWord(−0,5), floor(10^(P/20)·2^23))`. Se menor que a palavra do piso, recusar. Para uma seção admissível por (a)/(b)/(c), esse piso não foi vinculante na grade. Foram feitos **99** cotejos do atalho de uma seção com o gate completo.
**Os extremos abaixo são amostrais**: −24 dB e Q20 são bordas da busca, não limites absolutos demonstrados. Min/max por coluna não definem uma caixa: ganho, f e Q são acoplados. A quantização também cria pequenas ilhas/falhas na fronteira +9,2 dB.

| Tipo | Aceitas / avaliadas | Corte mais profundo testado | Maior boost testado (f / Q) | Maior Q testado aceito (f / ganho) |
|---|---:|---:|---|---|

| PK | 4010382 / 5780544 | -24 dB | 9.2 dB (20.000 Hz / 0.100000) | 20.000000000 (276.077 Hz / -24 dB) |
| LS | 3170673 / 5780544 | -24 dB | 9.2 dB (20.000 Hz / 0.130332) | 20.000000000 (796.214 Hz / -1.2 dB) |
| HS | 2329496 / 5780544 | -24 dB | 4.5 dB (20000.000 Hz / 0.100000) | 20.000000000 (833.739 Hz / -0.6 dB) |
| LP | 8715 / 14784 | não se aplica | não se aplica | 2.742481757 (115.088 Hz / 0 dB) |
| HP | 8422 / 14784 | não se aplica | não se aplica | 2.742481757 (158.866 Hz / 0 dB) |

### Boost máximo por frequência, com algum Q admissível na grade
| f Hz | PK dB | LS dB | HS dB |
|---:|---:|---:|---:|

| 20 | 9.2 | 9.2 | 0 |
| 30 | 9.2 | 9.2 | 0 |
| 50 | 9.2 | 9.2 | 0.1 |
| 100 | 9.2 | 9.2 | 0.2 |
| 300 | 9.2 | 9.2 | 0.8 |
| 1000 | 9.2 | 9.2 | 2.6 |
| 4000 | 9.2 | 9.2 | 3.3 |
| 10000 | 9.2 | 9.2 | 3.9 |
| 20000 | 9.2 | 5.9 | 4.5 |

### Q máximo por frequência e ganho fixo (amostrado)
| f Hz | PK −24 dB | PK 0 dB | PK +6 dB | LS −24 dB | LS +6 dB | HS −24 dB | LP | HP |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|

| 20 | 1.414214 | 0.458718 | 0.329406 | 0.832553 | 0.401810 | 0.236547 | 0.458718 | 0.329406 |
| 30 | 2.104225 | 0.729266 | 0.500000 | 1.238766 | 0.597857 | 0.351961 | 0.729266 | 0.523687 |
| 50 | 3.574335 | 1.159382 | 0.832553 | 2.104225 | 1.015548 | 0.597857 | 1.159382 | 0.832553 |
| 100 | 7.406054 | 2.402249 | 1.725058 | 2.930263 | 2.000000 | 1.159382 | 2.402249 | 1.725058 |
| 300 | 20.000000 | 6.931448 | 4.977481 | 2.930263 | 2.104225 | 2.930263 | 2.742482 | 2.742482 |
| 1000 | 20.000000 | 20.000000 | 16.396131 | 2.930263 | 2.104225 | 2.930263 | 2.742482 | 2.742482 |
| 4000 | 20.000000 | 20.000000 | 20.000000 | 2.930263 | 2.104225 | 2.930263 | 2.742482 | 2.742482 |
| 10000 | 20.000000 | 20.000000 | 20.000000 | 2.930263 | 2.104225 | 2.930263 | 2.742482 | 2.742482 |
| 20000 | 20.000000 | 20.000000 | 20.000000 | 2.930263 | — | 2.930263 | 2.742482 | 2.742482 |

### Menor f amostrada com algum ganho viável
| Q | PK Hz | LS Hz | HS Hz | LP Hz | HP Hz |
|---:|---:|---:|---:|---:|---:|

| 0.1 | 20.000000 | 20.000000 | 20.000000 | 20.000000 | 20.000000 |
| 0.5 | 20.000000 | 20.000000 | 20.942571 | 20.942571 | 28.908795 |
| 0.707 | 20.000000 | 20.000000 | 28.908795 | 28.908795 | 41.785923 |
| 1 | 20.000000 | 22.963072 | 41.785923 | 41.785923 | 57.680630 |
| 2 | 27.607685 | 45.817353 | 83.373877 | 83.373877 | 115.087987 |
| 4 | 55.084574 | 126.191469 | 166.352754 | — | — |
| 10 | 138.366194 | 381.092144 | 417.859226 | — | — |
| 20 | 276.076853 | 796.214341 | 833.738767 | — | — |

### O que vincula a região
- **PK:** (c) limita boost a ~+9,2 dB; (a:b0) elimina boosts largos em alta f; feedback (a:−a1/−a2) restringe Q alto em baixa f. Em cortes muito largos/profundos de baixa f, (b) também cria **Q mínimo**: PK20 Hz / −24 dB / Q0,1 tem raio **0.999967119554975** e falha em (b). Em 20 Hz, −24 dB só passa na grade para Q≈0,401810…1,414214. Não é correto atribuir todo limite de Q baixo-f ao raio: os máximos de feedback são frequentemente mais restritivos.
- **LS:** cortes de −24 dB passam, mas Q alto cria ressaltos positivos e aciona (c), mesmo em um shelf de ganho negativo. Boost de +9,2 dB exige Q moderado/baixo; em 20 kHz o maior boost amostrado cai a +5,9 dB por coeficientes. Não extrapolar Q20 de um shelf quase nulo para um shelf intenso.
- **HS:** todos os níveis −24…0 dB têm exemplos aceitos, mas não em todo f/Q. Boost baixo-f é fortemente limitado por **b2**, além de b0/b1; em baixa f b0 e b2 se aproximam do ganho linear do shelf. Em 20/30 Hz nenhum boost de +0,1 dB da grade passa. O maior boost da busca é +4,5 dB em 20 kHz / Q0,1. Refinamento nesse ponto: fronteira entre **4.521471066746** e **4.521471066746** dB, falhando em a:b0. Esse refinamento local não prova um máximo global entre os pontos da grade.
- **LP/HP:** ambos são úteis. Q alto é limitado por (c), não por um inexistente ganho de controle: em 1 kHz a fronteira Q é ~2.838948400 (LP) / 2.838944714 (HP). A grade log encontrou Q máximo 2.742481757. Em baixa f, feedback/coefs estreitam a faixa antes desse limite de ressonância.
- **LP útil:** 8/10/20 kHz com Q0,5–0,7 está dentro da caixa validada abaixo. Nenhum ganho é editável; amplificação ressonante é calculada pelo gate.
- **OFF:** `[1,0,0,0,0]` passa todos os limites. Não possui polos nem ressonância; não há byte de tipo no fio.

Contagens de violações por restrição (podem se sobrepor):
| Tipo | Contagens |
|---|---|

| PK | b:pole-radius=179648; c:section-peak=863844; a:-a1=970983; a:b1=970983; a:-a2=1020886; a:b2=852392; a:b0=184750 |
| LS | b:pole-radius=149170; c:section-peak=2260351; a:-a1=1016683; a:b1=1015129; a:-a2=1069166; a:b2=997007; a:b0=137322 |
| HS | b:pole-radius=215927; a:b2=1929431; a:b1=1984765; a:b0=1847543; c:section-peak=2257778; a:-a1=1175444; a:-a2=1227429 |
| LP | a:-a1=2777; a:-a2=2911; c:section-peak=5376; b:pole-radius=430 |
| HP | a:b2=3363; a:-a1=2777; a:b1=2832; a:-a2=2911; c:section-peak=5376; b:pole-radius=430 |

### HP subsônico solicitado, pré −0,5 dB
| f Hz | Q | Passa? | Restrições |
|---:|---:|---|---|

| 20 | 0.5 | não | a:b2:stage-1, a:-a1:stage-1, a:b1:stage-1, a:-a2:stage-1 |
| 20 | 0.707 | não | a:b2:stage-1, a:-a1:stage-1, a:b1:stage-1, a:-a2:stage-1 |
| 25 | 0.5 | não | a:b2:stage-1 |
| 25 | 0.707 | não | a:b2:stage-1, a:-a1:stage-1, a:b1:stage-1, a:-a2:stage-1 |
| 30 | 0.5 | sim | — |
| 30 | 0.707 | não | a:b2:stage-1 |
| 35 | 0.5 | sim | — |
| 35 | 0.707 | não | a:b2:stage-1 |

Primeira f que passa, por refinamento local: **28.556523477 Hz em Q0,5** e **40.360091770 Hz em Q0,707**; b2 é o limite final. HP20/Q0,3 passa, mas é mais amortecido. Recomendar experimentalmente HP30/Q0,5 em vez de anunciar HP20/Q0,707 como “seguro pelo envelope”.

## 4. Soft ranges da UI e arraste
Caixas simples conservadoras, **com pré automático**; controles fora delas podem existir num modo avançado que sempre consulta o gate. Não usar os máximos globais da seção anterior como caixa retangular.
| Perfil | f Hz | Ganho dB | Q | Pontos extras / falhas | Menor folga em coeficientes (LSB) |
|---|---|---|---|---:|---:|

| PK-main | 150…20000 | -24…6 | 1…2 | 999621 / 0 | 107257 |
| PK-narrow | 300…20000 | -24…9 | 2…4 | 1099251 / 0 | 33499 |
| LS | 80…1000 | -24…6 | 0.5…0.7 | 999621 / 0 | 483715 |
| HS-cut | 80…20000 | -24…0 | 0.5…0.7 | 800361 / 0 | 143875 |
| HS-boost | 8000…20000 | -24…2 | 0.5…0.7 | 866781 / 0 | 14073305 |
| LP | 30…20000 | não se aplica | 0.5…0.7 | 3321 / 0 | 17603 |
| HP | 50…20000 | não se aplica | 0.5…0.7 | 3321 / 0 | 62855 |

- Cada caixa foi verificada em 81 f × 41 Q × todos os ganhos em passos de 0,1 dB, incluindo cantos; todas tiveram zero violações e folga positiva. **Isto não é prova intervalar sobre cada real do contínuo.** O gate permanece obrigatório mesmo para uma seção; não liberar um write apenas pelo pertencimento à caixa.
- Passo proposto: ganho/pré 0,1 dB; frequência log (exibição arredondada a 1 Hz); Q log (exibição com 0,01). Revalidar **após** snapping/arredondamento. Pré nominal −25,5…−0,5 dB; com auto, teto dinâmico dependente da curva e arredondamento para mais atenuação. Nem todo pré da faixa é admissível com todo boost.
- Curvas completas: soma de boosts, cancelamentos, ordem, picos de prefixos/saída, DC e orçamento de pré continuam sendo restrições conjuntas. Uma caixa aprovada para uma seção não garante dez delas. Os limites (a)–(c) também não substituem (d)/(e).
- Arraste: conservar a última curva aprovada e interpolar ganho linearmente, f/Q no log; manter a ordem real do fio. Avançar em pequenos passos em direção ao cursor. Ao primeiro ponto recusado, fazer busca binária entre esse ponto e o último aceito (por exemplo 24 iterações), parar na fronteira, mostrar o motivo, aplicar snapping e testar novamente. Nunca presumir que a região inteira do segmento é convexa/monótona: não saltar uma zona recusada para uma ilha aceita mais adiante. Nem a amostragem dos passos prova ausência de microilhas de quantização; o estado final é sempre testado.
- Desacoplar o cálculo do arraste do write e executar o cálculo em worker na integração futura; este dispatch não alterou a UI nem gravou no cabo.

## 5. Ordem: gate versus “cortes antes dos reforços”
- O gate torna essa regra **não obrigatória como condição separada**, pois mede a ordem que será efetivamente enviada. Ela continua uma boa ordem inicial, não um certificado.
- Auri oficial: passa; Auri ordenado por f também passa em (d), pico **-0.21186325501323955** dB, apesar de intercalar boosts e cortes. Auri invertido falha com **4.991442752338761** dB.
- Harman oficial: **-0.20368875272917986** dB; ordenado por f: **4.789768434050782**; invertido: **9.133111650115785**. A saída ideal continua a mesma, mas os dois rearranjos falham em (d).
- **11/11 invertidos** e **8/11 ordenados por f** falham em (d); Referência ordenado por f já falha em −0,172996 dB, embora ainda esteja abaixo de 0 dB. Os outros três ordenados por f passam: não alegamos que todo rearranjo falha.
- Contraexemplo à suficiência da regra: corte PK100 Hz/−1 dB/Q1, depois dois boosts PK1 kHz/+6 dB/Q1, sete OFF, pré −0,5: cortes primeiro mas pico **11.489886937** dB, reprovado.

## 6. Neutro
| Candidato | Gate | CRC16 do payload | Bytes finais LE | Raio dos polos | Nível efetivo dB |
|---|---|---|---|---:|---:|

| neutro_OFF | passa | 0x4fff | ff 4f | 0 | -0.49999958245018883 |
| neutro_PK | passa | 0xef17 | 17 ef | 0.9547678944815365 | -0.49999958245018883 |

**Recomendação: 10×OFF + pré −0,5 dB.** Os dois têm transferência matemática unitária antes do pré, mas OFF elimina os polos/estados de uma identidade por cancelamento. PK0 dB em 1 kHz/Q0,707 conserva polos em 0,9547678944815365, desnecessários e sujeitos à aritmética interna desconhecida. Nenhum dos dois é um preset neutro oficial medido em hardware.

## 7. Saltos de nível: matriz completa
`levelDb` exportado: média aritmética dos ganhos em dB de **93 frequências** da grade oficial (300 Hz–3 kHz), somando o pré; usa coeficientes Q27 e pré Q23. A grade reconstruída foi comparada com a do dump oficial: **true**. Não é LUFS, ISO 226 nem predição exata da sonoridade da música.
| Preset | levelDb |
|---|---:|

| padrao | -3.5468069512111837 |
| pref6 | -3.6576270855430835 |
| emv | -9.05022231105811 |
| basshead | -5.115161247916879 |
| energico | -3.5976145935536734 |
| musical | -3.6604119567480673 |
| analitico | -3.6599701213599265 |
| referencia | -3.6489124878851666 |
| harman | -3.645895965641124 |
| vdsf | -3.625452216287962 |
| etymotic | -3.6239722723245724 |
| neutro_OFF | -0.49999958245018883 |
| neutro_PK | -0.49999958245018883 |

Linhas = curva antiga; colunas = nova. Positivo = aumenta. Unidades dB; arredondado a 3 casas aqui, valores completos no JSON. N1=Neutro OFF; N2=Neutro PK.

| de → para | padrao | pref6 | emv | basshead | energico | musical | analitico | referencia | harman | vdsf | etymotic | N1 | N2 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| padrao | +0.000 | -0.111 | -5.503 | -1.568 | -0.051 | -0.114 | -0.113 | -0.102 | -0.099 | -0.079 | -0.077 | +3.047 | +3.047 |
| pref6 | +0.111 | +0.000 | -5.393 | -1.458 | +0.060 | -0.003 | -0.002 | +0.009 | +0.012 | +0.032 | +0.034 | +3.158 | +3.158 |
| emv | +5.503 | +5.393 | +0.000 | +3.935 | +5.453 | +5.390 | +5.390 | +5.401 | +5.404 | +5.425 | +5.426 | +8.550 | +8.550 |
| basshead | +1.568 | +1.458 | -3.935 | +0.000 | +1.518 | +1.455 | +1.455 | +1.466 | +1.469 | +1.490 | +1.491 | +4.615 | +4.615 |
| energico | +0.051 | -0.060 | -5.453 | -1.518 | +0.000 | -0.063 | -0.062 | -0.051 | -0.048 | -0.028 | -0.026 | +3.098 | +3.098 |
| musical | +0.114 | +0.003 | -5.390 | -1.455 | +0.063 | +0.000 | +0.000 | +0.011 | +0.015 | +0.035 | +0.036 | +3.160 | +3.160 |
| analitico | +0.113 | +0.002 | -5.390 | -1.455 | +0.062 | -0.000 | +0.000 | +0.011 | +0.014 | +0.035 | +0.036 | +3.160 | +3.160 |
| referencia | +0.102 | -0.009 | -5.401 | -1.466 | +0.051 | -0.011 | -0.011 | +0.000 | +0.003 | +0.023 | +0.025 | +3.149 | +3.149 |
| harman | +0.099 | -0.012 | -5.404 | -1.469 | +0.048 | -0.015 | -0.014 | -0.003 | +0.000 | +0.020 | +0.022 | +3.146 | +3.146 |
| vdsf | +0.079 | -0.032 | -5.425 | -1.490 | +0.028 | -0.035 | -0.035 | -0.023 | -0.020 | +0.000 | +0.001 | +3.125 | +3.125 |
| etymotic | +0.077 | -0.034 | -5.426 | -1.491 | +0.026 | -0.036 | -0.036 | -0.025 | -0.022 | -0.001 | +0.000 | +3.124 | +3.124 |
| N1 | -3.047 | -3.158 | -8.550 | -4.615 | -3.098 | -3.160 | -3.160 | -3.149 | -3.146 | -3.125 | -3.124 | +0.000 | +0.000 |
| N2 | -3.047 | -3.158 | -8.550 | -4.615 | -3.098 | -3.160 | -3.160 | -3.149 | -3.146 | -3.125 | -3.124 | +0.000 | +0.000 |

**Maior salto positivo: Em V → Neutro OFF ou Neutro PK = +8.550222728607922 dB.** Entre apenas os oficiais: Em V → Auri = +5.503415359846927 dB.
O comentário da página sobre igualar níveis não corresponde a uma normalização uniforme destes payloads efetivamente escritos: Em V fica em −9,050222311 dB nesta métrica, Basshead em −5,115161248 dB e a maioria dos outros em torno de −3,6 dB. Não assumir ausência de salto só porque ambos são presets oficiais.
**Aviso proposto:** aumento previsto **≥ +3 dB**: “A nova curva pode soar mais alta. Abaixe o volume antes de gravar.” Se a curva atual do cabo é desconhecida, avisar **sempre**; localStorage não é readback. Este limiar é UX conservadora (≈1,41× amplitude para ganho uniforme), não limiar médico de exposição nem equivalência garantida de volume percebido. Incluir aviso geral de volume antes do primeiro write, mesmo com estimativa abaixo do limiar.

## 8. Verificação, reprodução e limites
```powershell
node --check design/analysis/gate.mjs
node --check design/analysis/gate.test.mjs
node --check design/analysis/limites-v2.mjs
node --check design/analysis/render-limites-v2.mjs
node design/analysis/gate.test.mjs
node design/analysis/limites-v2.mjs
node design/analysis/render-limites-v2.mjs
```
- Todos os 11 presets passam; todos os invertidos falham; 8/11 por frequência falham em (d). Codec, pureza/repetibilidade, fronteira do pré, piso/teto, OFF e independência de (c) têm asserts.
- Não há prova de que o firmware use a realização RBJ/Direct Form esperada nem de quantos bits internos/guardas existem. Não medimos clipping, flash, estabilidade temporal ou suporte efetivo de novos tipos.
- (d) cobre prefixos **somente entre 20 Hz e 20 kHz**; (e) cobre saída em DC–48 kHz. Prefixos subsônicos/ultrassônicos podem escapar ao orçamento interno. Para um editor de produção, considerar um limite adicional de prefixos em toda a banda, com política explícita compatível com o Basshead oficial, além de margem de transientes.
- O envelope aceita diferentes sinais/combinações/polos dentro de máximos marginais que não apareceram juntos nos presets. Ele é deliberadamente chamado “observado-envelope”, não “hardware comprovadamente seguro”.
- Apenas `design/analysis/` recebeu código e dados deste dispatch; nenhuma alteração em src/test/tools/docs/package.json, dependência, commit ou acesso HID.
