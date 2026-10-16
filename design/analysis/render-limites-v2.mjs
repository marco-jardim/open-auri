#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { gate, analyseSection, autoPreampForSection, THRESHOLDS } from './gate.mjs';
import { preampWord, encodeSection, designSection } from '../../src/dsp/eq0xcb.mjs';

const resultPath = new URL('./limites-v2.json', import.meta.url);
const r = JSON.parse(await readFile(resultPath, 'utf8'));
const fixture = JSON.parse(await readFile(new URL('../../test/fixtures/eq0xcb.reference.json', import.meta.url), 'utf8'));
const one = (band) => [band, ...Array.from({ length: 9 }, () => ({ kind: 'OFF' }))];
function singleCheck(band) {
  const m = analyseSection(band), pre = autoPreampForSection(m);
  return { ok: m.reasons.length === 0 && pre !== null, reasons: m.reasons, autoPreampDb: pre,
    poleRadius: m.poleRadius, words: m.words, fullPeak: m.fullPeak };
}
function boundary(fn, low, high, increasingAcceptance) {
  assert.equal(fn(low).ok, !increasingAcceptance);
  assert.equal(fn(high).ok, increasingAcceptance);
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    if (fn(mid).ok === increasingAcceptance) high = mid;
    else low = mid;
  }
  return { low, high, lowResult: fn(low), highResult: fn(high) };
}
const refined = {
  hpMinFrequencyQ05: boundary((freqHz) => singleCheck({ kind: 'HP', freqHz, qFactor: 0.5 }), 20, 50, true),
  hpMinFrequencyQ0707: boundary((freqHz) => singleCheck({ kind: 'HP', freqHz, qFactor: 0.707 }), 20, 60, true),
  hsMaxBoost20kQ01: boundary((gainDb) => singleCheck({ kind: 'HS', freqHz: 20000, gainDb, qFactor: 0.1 }), 4.5, 4.6, false),
  lpMaxQ1k: boundary((qFactor) => singleCheck({ kind: 'LP', freqHz: 1000, qFactor }), 2.7, 3, false),
  hpMaxQ1k: boundary((qFactor) => singleCheck({ kind: 'HP', freqHz: 1000, qFactor }), 2.7, 3, false),
};
const examples = {
  lowFrequencyOverdampedCut: singleCheck({ kind: 'PK', freqHz: 20, gainDb: -24, qFactor: 0.1 }),
  hp20Broad: singleCheck({ kind: 'HP', freqHz: 20, qFactor: 0.3 }),
  sectionCapNotRedundant: gate(one({ kind: 'PK', freqHz: 1000, gainDb: 12, qFactor: 4 }), -12.6),
  cutsFirstStillCanFail: gate([
    { kind: 'PK', freqHz: 100, gainDb: -1, qFactor: 1 },
    { kind: 'PK', freqHz: 1000, gainDb: 6, qFactor: 1 },
    { kind: 'PK', freqHz: 1000, gainDb: 6, qFactor: 1 },
    ...Array.from({ length: 7 }, () => ({ kind: 'OFF' })),
  ], -0.5),
};
assert.ok(examples.lowFrequencyOverdampedCut.reasons.includes('b:pole-radius'));
assert.ok(examples.hp20Broad.ok);
assert.deepEqual(examples.sectionCapNotRedundant.reasons, ['c:section-peak:stage-1']);
assert.ok(examples.cutsFirstStillCanFail.reasons.includes('d:internal-audible'));
let pkDcResidualMaxWords = 0, nyquistUnityMaxResidualWords = 0;
for (const p of Object.values(fixture.presets)) for (const band of p.eqBands) {
  const w = encodeSection(designSection(band));
  if (band.kind === 'PK') pkDcResidualMaxWords = Math.max(pkDcResidualMaxWords, Math.abs(w[0] + w[1] - 2 ** 27 + w[4]));
  nyquistUnityMaxResidualWords = Math.max(nyquistUnityMaxResidualWords,
    Math.abs(w[0] - w[3] + w[1] - 2 ** 27 - w[2] + w[4]));
}
r.refinedBoundaries = refined;
r.examples = examples;
r.proof.pkDcSymmetryMaxResidualWords = pkDcResidualMaxWords;
r.proof.allOfficialNyquistUnityMaxResidualWords = nyquistUnityMaxResidualWords;
await writeFile(resultPath, JSON.stringify(r, null, 2) + '\n');

const text = [], add = (...s) => text.push(...s, '');
const f = (x, n = 9) => x === null ? '—' : Number(x).toFixed(n);
const sign = (x, n = 6) => `${x >= 0 ? '+' : ''}${x.toFixed(n)}`;
const kinds = Object.entries(r.sweep.kinds);
const total = kinds.reduce((n, [, s]) => n + s.tested, 0);
const softTested = r.softRanges.reduce((n, b) => n + b.validation.tested, 0);
const nearestRow = (kind, hz) => r.sweep.kinds[kind].perFrequency.find((v) => v.frequencyHz === hz);
add('# Limites v2 — gate do envelope observado',
  `Data: ${r.metadata.generatedAt}; Node ${r.metadata.node}. Artefatos: [gate.mjs](gate.mjs), [limites-v2.json](limites-v2.json).`,
  '**Conclusão:** ampliar experimentalmente os tipos e parâmetros com gate em coeficientes quantizados é defensável como política conservadora de similaridade; **não é prova de segurança do firmware**. Os 11 presets oficiais passam. Foram avaliadas **' + total.toLocaleString('en-US') + '** combinações distintas e **' + softTested.toLocaleString('en-US') + '** pontos adicionais das caixas suaves, sem HID.',
  'O chip não recebe um byte de tipo, mas máximos marginais de coeficientes + raio dos polos + picos senoidais não limitam estados internos, norma de resposta ao impulso, limit cycles, transientes, sinais de banda larga ou aritmética desconhecida. “Passa no gate” não significa “já foi gravado pela Kuba”.');

add('## 1. Evidência de biquad não restrito a PK',
  'Para PK, `b1 == a1`; também `b0+b2 == 1+a2` antes da quantização. Nos **106 PK** oficiais, a primeira igualdade é exata nos inteiros Q27; a segunda tem resíduo máximo de ' + pkDcResidualMaxWords + ' LSB.',
  '| LS oficial / estágio | b1−a1 (LSB Q27) | b1−a1 (float quantizado) | (b0+b2)−(1+a2), LSB |',
  '|---|---:|---:|---:|');
for (const s of r.proof.lowShelves) text.push(`| ${s.preset} / ${s.stage} | ${s.b1MinusA1Words} | ${s.b1MinusA1} | ${s.dcSymmetryResidualWords} |`);
add('', 'Os **4 LS** quebram ambas as simetrias PK por milhares de LSB: não são diferenças de arredondamento. Portanto os payloads oficiais exercitam numeradores que não são os de PK, com `b1` independente de `a1`. Isso é forte evidência de suporte a biquads gerais no layout conhecido, não uma demonstração de aceitação de qualquer conjunto de coeficientes.',
  'Cuidado adicional: todos os PK/LS oficiais ainda têm ganho unitário em Nyquist, com resíduo máximo de ' + nyquistUnityMaxResidualWords + ' LSB na identidade do numerador/denominador em z=−1. HS/LP/HP e OFF introduzem combinações/simetrias diferentes. A implementação genérica é plausível pelo formato, mas não foi inspecionada nem medida no firmware.');

add('## 2. Gate puro e limiares exatos',
  '`gate(eqBands, preampDb) → { ok, reasons, metrics }`, exportado de `gate.mjs`. Sem HID, DOM, I/O por chamada ou mutação dos argumentos. Usa `encodePayload`, `encodeSection`, palavras Q27 e pré Q23 reais.',
  '| a — posição no fio | Limite absoluto em LSB | Limite normalizado exato |', '|---|---:|---:|');
THRESHOLDS.coefficientPositions.forEach((p, i) => text.push(`| ${p} | ${THRESHOLDS.coefficientAbsWords[i]} | ${THRESHOLDS.coefficientAbs[i]} |`));
add('', '| Verificação | Limite exato | Origem |', '|---|---:|---|',
  `| b — raio Q27 | ${THRESHOLDS.poleRadius} | maior raio observado |`,
  `| c — pico individual DC–48 kHz | ${THRESHOLDS.sectionPeakDb} dB | maior pico Q27 individual |`,
  `| d — qualquer prefixo, pré incluído, 20 Hz–20 kHz | ${THRESHOLDS.internalAudibleDb} dB | pior prefixo oficial Q27/Q23 |`,
  `| e — saída 20 Hz–20 kHz | ${THRESHOLDS.outputAudibleDb} dB | pior saída oficial Q27/Q23 |`,
  `| e — saída DC–48 kHz | ${THRESHOLDS.outputFullDb} dB | Basshead em DC |`,
  '| f — validação do codec | `encodePayload` não pode lançar | 10 seções, tipos, finitude, estabilidade Q27, int32 etc. |',
  '| g — pré nominal | −25,5…−0,5 dB | teto oficial; piso de usabilidade S1 |',
  'Os limites vêm de `envelope.json`, usando os **máximos quantizados**, não os valores float arredondados −0,2037 / −0,4709 / +9,2. Tolerâncias explícitas somente de cálculo: **1e−8 dB** e **2e−15** no raio; coeficientes são comparados em inteiros, sem folga.',
  '**(c) não é redundante.** PK 1 kHz / +12 dB / Q4, pré −12,6 dB passa (a), (b), (d), (e), (f), (g), mas falha só em (c). Pré/cancelamentos poderiam ocultar um pico individual maior. Mantemos (c) como política de similaridade independente; não afirmamos que ganho da seção isolada seja, por si só, a carga de acumulador no circuito.',
  '**Pré:** qualquer redução de ganho não nula é atenuação na aritmética ideal; o piso −25,5 dB é compatibilidade/usabilidade do S1, não limite medido do chip. Nesse piso o Q23 ainda é **' + preampWord(-25.5) + '**, longe de zero. Teto nominal −0,5 dB vira **' + preampWord(-0.5) + '**, ou ' + r.neutrals.neutro_OFF.levelDb + ' dB quantizados. Mais negativo reduz picos dos prefixos, mas não resolve coeficientes/polos/pico individual reprovados.');

add('## 3. Método e região viável (uma seção + nove OFF)',
  `Grade: **${r.sweep.frequenciesHz.length} frequências** log 20–20.000 Hz (inclui âncoras), **${r.sweep.qFactors.length} Qs** log 0,1–20, **391 ganhos** −24…+15 dB em 0,1 dB. LP/HP não têm ganho: cada f/Q foi calculado uma vez; repetir 391 rótulos ignorados seria redundante.`,
  'Picos individuais: extremos analíticos da razão de dois polinômios quadráticos em `t=sin²(ω/2)`, avaliando extremos e raízes reais da derivada; resposta avaliada na forma estável do codec. Diferença máxima contra os 110 picos Q27 do estudo anterior: **' + r.validation.analyticSectionPeakMaxDifferenceDb + ' dB**.',
  'Cascatas/prefixos: mesma grade de 16.384 intervalos log + refinamento local do estudo anterior. Isso reproduz os valores publicados, mas não é certificação por aritmética intervalar.',
  'Pré automático = maior **palavra Q23** permitida pelo teto nominal e por (d)/(e). Se o limite é P: escolher `min(preampWord(−0,5), floor(10^(P/20)·2^23))`. Se menor que a palavra do piso, recusar. Para uma seção admissível por (a)/(b)/(c), esse piso não foi vinculante na grade. Foram feitos **' + r.validation.gateSpotChecks + '** cotejos do atalho de uma seção com o gate completo.',
  '**Os extremos abaixo são amostrais**: −24 dB e Q20 são bordas da busca, não limites absolutos demonstrados. Min/max por coluna não definem uma caixa: ganho, f e Q são acoplados. A quantização também cria pequenas ilhas/falhas na fronteira +9,2 dB.');
add('| Tipo | Aceitas / avaliadas | Corte mais profundo testado | Maior boost testado (f / Q) | Maior Q testado aceito (f / ganho) |', '|---|---:|---:|---|---|');
for (const [kind, s] of kinds) text.push(`| ${kind} | ${s.accepted} / ${s.tested} | ${['LP', 'HP'].includes(kind) ? 'não se aplica' : s.deepestCut.gainDb + ' dB'} | ${['LP', 'HP'].includes(kind) ? 'não se aplica' : `${s.highestBoost.gainDb} dB (${f(s.highestBoost.frequencyHz, 3)} Hz / ${f(s.highestBoost.qFactor, 6)})`} | ${f(s.maxQ.qFactor, 9)} (${f(s.maxQ.frequencyHz, 3)} Hz / ${s.maxQ.gainDb} dB) |`);
add('', '### Boost máximo por frequência, com algum Q admissível na grade',
  '| f Hz | PK dB | LS dB | HS dB |', '|---:|---:|---:|---:|');
for (const hz of [20, 30, 50, 100, 300, 1000, 4000, 10000, 20000]) text.push(`| ${hz} | ${nearestRow('PK', hz).maxGainDb} | ${nearestRow('LS', hz).maxGainDb} | ${nearestRow('HS', hz).maxGainDb} |`);
add('', '### Q máximo por frequência e ganho fixo (amostrado)',
  '| f Hz | PK −24 dB | PK 0 dB | PK +6 dB | LS −24 dB | LS +6 dB | HS −24 dB | LP | HP |',
  '|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const hz of [20, 30, 50, 100, 300, 1000, 4000, 10000, 20000]) {
  const pk = nearestRow('PK', hz), ls = nearestRow('LS', hz), hs = nearestRow('HS', hz);
  text.push(`| ${hz} | ${f(pk.qByGain[-24].max, 6)} | ${f(pk.qByGain[0].max, 6)} | ${f(pk.qByGain[6].max, 6)} | ${f(ls.qByGain[-24].max, 6)} | ${f(ls.qByGain[6].max, 6)} | ${f(hs.qByGain[-24].max, 6)} | ${f(nearestRow('LP', hz).maxQ, 6)} | ${f(nearestRow('HP', hz).maxQ, 6)} |`);
}
add('', '### Menor f amostrada com algum ganho viável', '| Q | PK Hz | LS Hz | HS Hz | LP Hz | HP Hz |', '|---:|---:|---:|---:|---:|---:|');
for (const q of [0.1, 0.5, 0.707, 1, 2, 4, 10, 20]) text.push(`| ${q} | ${kinds.map(([, s]) => f(s.perQ.find((v) => v.q === q).minimumFrequencyHz, 6)).join(' | ')} |`);
add('', '### O que vincula a região',
  '- **PK:** (c) limita boost a ~+9,2 dB; (a:b0) elimina boosts largos em alta f; feedback (a:−a1/−a2) restringe Q alto em baixa f. Em cortes muito largos/profundos de baixa f, (b) também cria **Q mínimo**: PK20 Hz / −24 dB / Q0,1 tem raio **' + examples.lowFrequencyOverdampedCut.poleRadius + '** e falha em (b). Em 20 Hz, −24 dB só passa na grade para Q≈0,401810…1,414214. Não é correto atribuir todo limite de Q baixo-f ao raio: os máximos de feedback são frequentemente mais restritivos.',
  '- **LS:** cortes de −24 dB passam, mas Q alto cria ressaltos positivos e aciona (c), mesmo em um shelf de ganho negativo. Boost de +9,2 dB exige Q moderado/baixo; em 20 kHz o maior boost amostrado cai a +5,9 dB por coeficientes. Não extrapolar Q20 de um shelf quase nulo para um shelf intenso.',
  '- **HS:** todos os níveis −24…0 dB têm exemplos aceitos, mas não em todo f/Q. Boost baixo-f é fortemente limitado por **b2**, além de b0/b1; em baixa f b0 e b2 se aproximam do ganho linear do shelf. Em 20/30 Hz nenhum boost de +0,1 dB da grade passa. O maior boost da busca é +4,5 dB em 20 kHz / Q0,1. Refinamento nesse ponto: fronteira entre **' + f(refined.hsMaxBoost20kQ01.low, 12) + '** e **' + f(refined.hsMaxBoost20kQ01.high, 12) + '** dB, falhando em ' + refined.hsMaxBoost20kQ01.highResult.reasons.join(', ') + '. Esse refinamento local não prova um máximo global entre os pontos da grade.',
  '- **LP/HP:** ambos são úteis. Q alto é limitado por (c), não por um inexistente ganho de controle: em 1 kHz a fronteira Q é ~' + f(refined.lpMaxQ1k.low, 9) + ' (LP) / ' + f(refined.hpMaxQ1k.low, 9) + ' (HP). A grade log encontrou Q máximo ' + f(r.sweep.kinds.LP.maxQ.qFactor, 9) + '. Em baixa f, feedback/coefs estreitam a faixa antes desse limite de ressonância.',
  '- **LP útil:** 8/10/20 kHz com Q0,5–0,7 está dentro da caixa validada abaixo. Nenhum ganho é editável; amplificação ressonante é calculada pelo gate.',
  '- **OFF:** `[1,0,0,0,0]` passa todos os limites. Não possui polos nem ressonância; não há byte de tipo no fio.');
add('Contagens de violações por restrição (podem se sobrepor):', '| Tipo | Contagens |', '|---|---|');
for (const [kind, s] of kinds) text.push(`| ${kind} | ${Object.entries(s.failures).map(([name, count]) => `${name}=${count}`).join('; ')} |`);

add('', '### HP subsônico solicitado, pré −0,5 dB', '| f Hz | Q | Passa? | Restrições |', '|---:|---:|---|---|');
for (const h of r.hpExamples) text.push(`| ${h.frequencyHz} | ${h.qFactor} | ${h.ok ? 'sim' : 'não'} | ${h.reasons.join(', ') || '—'} |`);
add('', 'Primeira f que passa, por refinamento local: **' + f(refined.hpMinFrequencyQ05.high, 9) + ' Hz em Q0,5** e **' + f(refined.hpMinFrequencyQ0707.high, 9) + ' Hz em Q0,707**; b2 é o limite final. HP20/Q0,3 passa, mas é mais amortecido. Recomendar experimentalmente HP30/Q0,5 em vez de anunciar HP20/Q0,707 como “seguro pelo envelope”.');

add('## 4. Soft ranges da UI e arraste',
  'Caixas simples conservadoras, **com pré automático**; controles fora delas podem existir num modo avançado que sempre consulta o gate. Não usar os máximos globais da seção anterior como caixa retangular.',
  '| Perfil | f Hz | Ganho dB | Q | Pontos extras / falhas | Menor folga em coeficientes (LSB) |',
  '|---|---|---|---|---:|---:|');
for (const b of r.softRanges) text.push(`| ${b.id} | ${b.freqHz.join('…')} | ${['LP', 'HP'].includes(b.kind) ? 'não se aplica' : b.gainDb.join('…')} | ${b.qFactor.join('…')} | ${b.validation.tested} / ${b.validation.violations} | ${b.validation.margins.coefficientWords} |`);
add('', '- Cada caixa foi verificada em 81 f × 41 Q × todos os ganhos em passos de 0,1 dB, incluindo cantos; todas tiveram zero violações e folga positiva. **Isto não é prova intervalar sobre cada real do contínuo.** O gate permanece obrigatório mesmo para uma seção; não liberar um write apenas pelo pertencimento à caixa.',
  '- Passo proposto: ganho/pré 0,1 dB; frequência log (exibição arredondada a 1 Hz); Q log (exibição com 0,01). Revalidar **após** snapping/arredondamento. Pré nominal −25,5…−0,5 dB; com auto, teto dinâmico dependente da curva e arredondamento para mais atenuação. Nem todo pré da faixa é admissível com todo boost.',
  '- Curvas completas: soma de boosts, cancelamentos, ordem, picos de prefixos/saída, DC e orçamento de pré continuam sendo restrições conjuntas. Uma caixa aprovada para uma seção não garante dez delas. Os limites (a)–(c) também não substituem (d)/(e).',
  '- Arraste: conservar a última curva aprovada e interpolar ganho linearmente, f/Q no log; manter a ordem real do fio. Avançar em pequenos passos em direção ao cursor. Ao primeiro ponto recusado, fazer busca binária entre esse ponto e o último aceito (por exemplo 24 iterações), parar na fronteira, mostrar o motivo, aplicar snapping e testar novamente. Nunca presumir que a região inteira do segmento é convexa/monótona: não saltar uma zona recusada para uma ilha aceita mais adiante. Nem a amostragem dos passos prova ausência de microilhas de quantização; o estado final é sempre testado.',
  '- Desacoplar o cálculo do arraste do write e executar o cálculo em worker na integração futura; este dispatch não alterou a UI nem gravou no cabo.');

add('## 5. Ordem: gate versus “cortes antes dos reforços”',
  '- O gate torna essa regra **não obrigatória como condição separada**, pois mede a ordem que será efetivamente enviada. Ela continua uma boa ordem inicial, não um certificado.',
  '- Auri oficial: passa; Auri ordenado por f também passa em (d), pico **' + r.validation.reordered.frequency.find((v) => v.preset === 'padrao').internalAudibleDb + '** dB, apesar de intercalar boosts e cortes. Auri invertido falha com **' + r.validation.reordered.reversed.find((v) => v.preset === 'padrao').internalAudibleDb + '** dB.',
  '- Harman oficial: **' + r.validation.official.harman.internalAudibleDb + '** dB; ordenado por f: **' + r.validation.reordered.frequency.find((v) => v.preset === 'harman').internalAudibleDb + '**; invertido: **' + r.validation.reordered.reversed.find((v) => v.preset === 'harman').internalAudibleDb + '**. A saída ideal continua a mesma, mas os dois rearranjos falham em (d).',
  '- **11/11 invertidos** e **8/11 ordenados por f** falham em (d); Referência ordenado por f já falha em −0,172996 dB, embora ainda esteja abaixo de 0 dB. Os outros três ordenados por f passam: não alegamos que todo rearranjo falha.',
  '- Contraexemplo à suficiência da regra: corte PK100 Hz/−1 dB/Q1, depois dois boosts PK1 kHz/+6 dB/Q1, sete OFF, pré −0,5: cortes primeiro mas pico **' + f(examples.cutsFirstStillCanFail.metrics.internalAudible.db, 9) + '** dB, reprovado.');

add('## 6. Neutro', '| Candidato | Gate | CRC16 do payload | Bytes finais LE | Raio dos polos | Nível efetivo dB |', '|---|---|---|---|---:|---:|');
for (const [id, n] of Object.entries(r.neutrals)) text.push(`| ${id} | passa | ${n.crc} | ${n.payload.slice(-2).map((v) => v.toString(16).padStart(2, '0')).join(' ')} | ${n.poleRadius} | ${n.levelDb} |`);
add('', '**Recomendação: 10×OFF + pré −0,5 dB.** Os dois têm transferência matemática unitária antes do pré, mas OFF elimina os polos/estados de uma identidade por cancelamento. PK0 dB em 1 kHz/Q0,707 conserva polos em 0,9547678944815365, desnecessários e sujeitos à aritmética interna desconhecida. Nenhum dos dois é um preset neutro oficial medido em hardware.');

add('## 7. Saltos de nível: matriz completa',
  '`levelDb` exportado: média aritmética dos ganhos em dB de **93 frequências** da grade oficial (300 Hz–3 kHz), somando o pré; usa coeficientes Q27 e pré Q23. A grade reconstruída foi comparada com a do dump oficial: **' + r.validation.meanGridMatchesOfficial + '**. Não é LUFS, ISO 226 nem predição exata da sonoridade da música.',
  '| Preset | levelDb |', '|---|---:|');
for (const [id, value] of Object.entries(r.loudness.levelsDb)) text.push(`| ${id} | ${value} |`);
add('', 'Linhas = curva antiga; colunas = nova. Positivo = aumenta. Unidades dB; arredondado a 3 casas aqui, valores completos no JSON. N1=Neutro OFF; N2=Neutro PK.');
const ids = Object.keys(r.loudness.levelsDb), labels = ids.map((id) => id === 'neutro_OFF' ? 'N1' : id === 'neutro_PK' ? 'N2' : id);
text.push(`| de → para | ${labels.join(' | ')} |`, `|---|${ids.map(() => '---:').join('|')}|`);
for (let i = 0; i < ids.length; i++) text.push(`| ${labels[i]} | ${ids.map((to) => sign(r.loudness.jumpDb[ids[i]][to], 3)).join(' | ')} |`);
add('', '**Maior salto positivo: Em V → Neutro OFF ou Neutro PK = +' + r.loudness.largestPositiveJump.db + ' dB.** Entre apenas os oficiais: Em V → Auri = +' + (r.loudness.levelsDb.padrao - r.loudness.levelsDb.emv) + ' dB.',
  'O comentário da página sobre igualar níveis não corresponde a uma normalização uniforme destes payloads efetivamente escritos: Em V fica em −9,050222311 dB nesta métrica, Basshead em −5,115161248 dB e a maioria dos outros em torno de −3,6 dB. Não assumir ausência de salto só porque ambos são presets oficiais.',
  '**Aviso proposto:** aumento previsto **≥ +3 dB**: “A nova curva pode soar mais alta. Abaixe o volume antes de gravar.” Se a curva atual do cabo é desconhecida, avisar **sempre**; localStorage não é readback. Este limiar é UX conservadora (≈1,41× amplitude para ganho uniforme), não limiar médico de exposição nem equivalência garantida de volume percebido. Incluir aviso geral de volume antes do primeiro write, mesmo com estimativa abaixo do limiar.');

add('## 8. Verificação, reprodução e limites',
  '```powershell', 'node --check design/analysis/gate.mjs', 'node --check design/analysis/gate.test.mjs',
  'node --check design/analysis/limites-v2.mjs', 'node --check design/analysis/render-limites-v2.mjs',
  'node design/analysis/gate.test.mjs', 'node design/analysis/limites-v2.mjs',
  'node design/analysis/render-limites-v2.mjs', '```',
  '- Todos os 11 presets passam; todos os invertidos falham; 8/11 por frequência falham em (d). Codec, pureza/repetibilidade, fronteira do pré, piso/teto, OFF e independência de (c) têm asserts.',
  '- Não há prova de que o firmware use a realização RBJ/Direct Form esperada nem de quantos bits internos/guardas existem. Não medimos clipping, flash, estabilidade temporal ou suporte efetivo de novos tipos.',
  '- (d) cobre prefixos **somente entre 20 Hz e 20 kHz**; (e) cobre saída em DC–48 kHz. Prefixos subsônicos/ultrassônicos podem escapar ao orçamento interno. Para um editor de produção, considerar um limite adicional de prefixos em toda a banda, com política explícita compatível com o Basshead oficial, além de margem de transientes.',
  '- O envelope aceita diferentes sinais/combinações/polos dentro de máximos marginais que não apareceram juntos nos presets. Ele é deliberadamente chamado “observado-envelope”, não “hardware comprovadamente seguro”.',
  '- Apenas `design/analysis/` recebeu código e dados deste dispatch; nenhuma alteração em src/test/tools/docs/package.json, dependência, commit ou acesso HID.');
await writeFile(new URL('./limites-v2.md', import.meta.url), text.join('\n'));
console.log(JSON.stringify({ report: 'design/analysis/limites-v2.md', lines: text.join('\n').split('\n').length,
  totalSweepCases: total, softRangeChecks: softTested, refinedBoundaries: refined,
  largestJump: r.loudness.largestPositiveJump }, null, 2));
