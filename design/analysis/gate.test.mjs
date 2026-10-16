import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gate, analyseSection, autoPreampForSection, sectionDb, THRESHOLDS } from './gate.mjs';
import { preampWord } from '../../src/dsp/eq0xcb.mjs';

const neutral = Object.freeze(Array.from({ length: 10 }, () => Object.freeze({ kind: 'OFF' })));
const first = (band) => [band, ...neutral.slice(1)];
assert.ok(gate(neutral, -0.5).ok);
assert.ok(gate(neutral, -25.5).ok);
assert.ok(gate(neutral, 0).reasons.includes('g:preamp-range'));
assert.ok(gate(neutral, -25.6).reasons.includes('g:preamp-range'));
assert.ok(gate(neutral, 0.1).reasons.some((r) => r.startsWith('f:codec:')));
assert.ok(gate(neutral.slice(1), -0.5).reasons.some((r) => r.startsWith('f:codec:')));
assert.ok(gate(first({ kind: 'unknown' }), -0.5).reasons.some((r) => r.startsWith('f:codec:')));
assert.ok(gate(first({ kind: 'PK', freqHz: NaN, qFactor: 1, gainDb: 0 }), -0.5).reasons.some((r) => r.startsWith('f:codec:')));
const independentSectionCap = gate(first({ kind: 'PK', freqHz: 1000, qFactor: 4, gainDb: 12 }), -12.6);
assert.deepEqual(independentSectionCap.reasons, ['c:section-peak:stage-1']);
const exactLimit = analyseSection({ kind: 'PK', freqHz: 1000, qFactor: 4, gainDb: 9 });
const preamp = autoPreampForSection(exactLimit);
const atBoundary = gate(first({ kind: 'PK', freqHz: 1000, qFactor: 4, gainDb: 9 }), preamp);
assert.ok(atBoundary.ok);
assert.ok(atBoundary.metrics.outputAudible.db <= THRESHOLDS.outputAudibleDb + 1e-8);
const nextWordDb = 20 * Math.log10((preampWord(preamp) + 1) / 2 ** 23);
assert.ok(gate(first({ kind: 'PK', freqHz: 1000, qFactor: 4, gainDb: 9 }), nextWordDb)
  .reasons.includes('e:output-audible'));
assert.equal(autoPreampForSection(analyseSection({ kind: 'OFF' })), -0.5);
const fixture = JSON.parse(await readFile(new URL('../../test/fixtures/eq0xcb.reference.json', import.meta.url), 'utf8'));
for (const [id, p] of Object.entries(fixture.presets)) assert.ok(gate(p.eqBands, p.preampDb).ok, id);
assert.deepEqual(gate(neutral, -0.5), gate(neutral, -0.5));
// Independent dense frequency sampling checks the analytic extremum search,
// including all newly proposed kinds and extreme sweep coordinates.
let analyticCases = 0;
for (const kind of ['PK', 'LS', 'HS', 'LP', 'HP']) for (const freqHz of [20, 1000, 20000]) {
  for (const qFactor of [0.1, 0.707, 20]) for (const gainDb of ['LP', 'HP'].includes(kind) ? [0] : [-24, 0, 9, 15]) {
    const m = analyseSection({ kind, freqHz, qFactor, gainDb });
    const samples = [0, 20, freqHz, 20000, 48000, ...Array.from({ length: 8193 }, (_, i) => 0.001 * 48000000 ** (i / 8192))];
    for (const frequency of samples) {
      assert.ok(sectionDb(m.section, frequency) <= m.fullPeak.db + 1e-7,
        `analytic peak missed ${kind} ${freqHz} ${qFactor} ${gainDb} @ ${frequency}`);
    }
    analyticCases++;
  }
}
console.log(`gate.test.mjs: passed (codec/ranges/section-cap/optimal Q23 auto-preamp/purity + 11 official presets + ${analyticCases} analytic peak cases)`);
