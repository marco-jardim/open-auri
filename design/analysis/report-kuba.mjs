#!/usr/bin/env node
// Build the evidence report OUTSIDE the repo. Source excerpts are read from the
// reviewed temp dump at runtime; no third-party implementation is vendored here.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const directory = join(tmpdir(), "Claude", "kuba-dump");
const template = await readFile(resolve(directory, 'template.html'), 'utf8');
const sourceLines = template.split('\n');
const metadata = JSON.parse(await readFile(resolve(directory, 'metadata.json'), 'utf8'));
const manifest = JSON.parse(await readFile(resolve(directory, '__bundler_manifest.json'), 'utf8'));
const fixtureText = await readFile(new URL('../../test/fixtures/eq0xcb.reference.json', import.meta.url), 'utf8');
const fixture = JSON.parse(fixtureText);
const numbers = JSON.parse(await readFile(new URL('./envelope.json', import.meta.url), 'utf8'));
const numericAppendix = await readFile(new URL('./envelope.md', import.meta.url), 'utf8');
assert.equal(numbers.metadata.fixtureSha256, createHash('sha256').update(fixtureText).digest('hex'),
  'Numeric outputs are stale: rerun envelope.mjs');
assert.equal(createHash('sha256').update(template).digest('hex'), metadata.templateSha256);
// Deliberately refuse evaluation of changed, unreviewed downloaded code. The
// decoder still saves changed bundles for inspection; it does not execute them.
assert.equal(metadata.templateSha256, fixture._provenance.templateSha256,
  'Template changed: review the new temp dump before evaluating its preset data');
function between(start, end, inclusiveEnd = false) {
  const a = template.indexOf(start), b = template.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return template.slice(a, inclusiveEnd ? b + end.length : b);
}
// Same restricted, timeout-limited extraction approach as the existing tool.
// vm is NOT a security boundary. Only the already-reviewed pinned file runs.
const reference = vm.runInContext(
  `${between('const DSP = {', 'module.exports = DSP;', true)}\n${between('const PK = ', '// Medição')}\n({ codec: DSP, presets: PRESETS })`,
  vm.createContext({}), { timeout: 5000 },
);
assert.equal(reference.presets.auri.length, 11);
assert.equal(Object.keys(manifest).length, metadata.assets.length);
for (const asset of metadata.assets) {
  const data = await readFile(resolve(directory, asset.filename));
  assert.equal(data.length, asset.bytes);
  assert.equal(createHash('sha256').update(data).digest('hex'), asset.sha256);
}
const toBand = (b) => ({ kind: b.type, freqHz: b.f, gainDb: b.g, qFactor: b.q });
for (const p of reference.presets.auri) {
  assert.deepEqual(JSON.parse(JSON.stringify(p.bands.map(toBand))), fixture.presets[p.id].eqBands);
  assert.equal(p.pre, fixture.presets[p.id].preampDb);
  assert.deepEqual(Array.from(reference.codec.blob(p.bands, p.pre)), fixture.presets[p.id].payload);
  assert.deepEqual(Array.from(reference.codec.packets(p.bands, p.pre), (p) => Array.from(p)), fixture.presets[p.id].reports);
  let seenBoost = false;
  for (const b of p.bands) {
    if (b.g > 0) seenBoost = true;
    assert.ok(!seenBoost || b.g >= 0, `${p.id}: cut after boost`);
  }
}
const scan = {
  inputElements: (template.match(/<input\b/gi) ?? []).length,
  selectElements: (template.match(/<select\b/gi) ?? []).length,
  textareaElements: (template.match(/<textarea\b/gi) ?? []).length,
  sendReportCalls: (template.match(/\.sendReport\s*\(/g) ?? []).length,
  sendFeatureReportCalls: (template.match(/\.sendFeatureReport\s*\(/g) ?? []).length,
  receiveReportCalls: (template.match(/\.receiveReport\s*\(/g) ?? []).length,
  receiveFeatureReportCalls: (template.match(/\.receiveFeatureReport\s*\(/g) ?? []).length,
  inputReportMentions: (template.match(/oninputreport|["']inputreport["']/g) ?? []).length,
};
assert.deepEqual(scan, { inputElements: 0, selectElements: 0, textareaElements: 0,
  sendReportCalls: 2, sendFeatureReportCalls: 0, receiveReportCalls: 0,
  receiveFeatureReportCalls: 0, inputReportMentions: 0 });
const lines = [];
const add = (...text) => lines.push(...text, '');
function evidence(title, ranges) {
  add(`**Evidence — ${title}; asset \`template.html\`:**`);
  for (const [from, to = from] of ranges) {
    const appLocation = from >= 252
      ? ` (\`template-script-00.js:${from - 251}${to === from ? '' : `–${to - 251}`}\`)` : '';
    add(`\`template.html:${from}${to === from ? '' : `–${to}`}\`${appLocation}:`,
      '```' + (from < 252 ? 'html' : 'js'), ...sourceLines.slice(from - 1, to), '```');
  }
}
add('# Kuba equalizer: decoded UI, write surface, and coefficient-space safety envelope',
  `Analysis date: ${metadata.fetchedAt}. Source: <https://equalizador.kuba.audio/>. Node ${process.version}.`,
  '**Scope:** static source inspection plus offline codec calculations. No USB/HID device was opened, enumerated, requested, or written. “Proven by the official tool” below means the application offers and serializes these exact combinations; it is not an independent hardware measurement.',
  '**Main finding:** the official page is preset-only. There are no editable band, gain, frequency, Q, preamp, or filter-kind controls. It does not provide evidence for widening the parameter ranges to an arbitrary Cartesian box.',
  '**Important extra finding:** the published ≤ −0.47 dB output bound is valid from 20 Hz upward, but not below 20 Hz: Basshead reaches +2.5 dB at DC and +1.033275658 dB at 5 Hz.');
add('## A. DECODE',
  '- Read `tools/extract-kuba-reference.mjs` first. Reused its JSON-decoded template extraction and, only after confirming the reviewed pin, its timeout-limited `node:vm` extraction of the DSP object and preset literals. The dumper itself executes no downloaded JavaScript.',
  `- Entire HTTP document SHA-256: **${metadata.pageSha256}**.`,
  `- Live decoded-template SHA-256: **${metadata.templateSha256}**.`,
  `- Fixture-pinned decoded-template SHA-256: **${metadata.pinnedTemplateSha256}**.`,
  `- **The live template matches the pinned template.** The outer HTML hash is a different object and must not be compared directly to the template pin.`,
  `- Dump destination: \`${directory}/\`. Includes original page, JSON islands, decoded template, separated inline app script, all 11 decoded assets, and metadata with asset SHA-256 values.`,
  '- The root contains a bundler runtime followed by `__bundler/manifest`, `__bundler/ext_resources`, `__bundler/page_order`, and `__bundler/template` JSON script islands.',
  '- `manifest` is an object keyed by asset UUID. Each entry has `mime`, `compressed`, and base64 `data`. Base64-decode **every** entry; `gunzipSync` only when `compressed` is true. Here just the SVG is gzip-compressed; the PNG and nine WOFF2 fonts are base64-only.',
  '- `ext_resources = []`: no external-resource ID-to-UUID entries. `page_order = []`: no nested HTML-page assets/iframes to decode. The generic runtime supports those features, but this bundle does not use them.',
  '- `template` is a JSON string containing the real HTML document. The runtime decodes assets, creates blob URLs (fonts use data URLs), substitutes UUID references, swaps the root DOM, then recreates script elements so they execute.',
  '- **The app is not hidden in a manifest JavaScript asset.** It is the single inline `<script>` at `template.html:252–504`, dumped as `template-script-00.js` (253 lines; first app statement is line 2 = template line 253). The app contains DSP design/serialization, fixed presets, embedded acoustic measurements/targets, canvas charting, localStorage state and WebHID writes.',
  '- UI CSS/HTML are also in `template.html`. There is no React/Babel app asset; those names appear only in comments/branches of the generic bundler runtime.',
  '- Third-party source and source-quoting report are kept only in the temp dump, not vendored into the repository. Repository helper scripts contain our decoding/analysis logic; numeric outputs are derived data.');
add('### Decoded manifest inventory',
  '| UUID | MIME | gzip? | Decoded bytes | Dump filename |', '|---|---|---|---:|---|');
for (const asset of metadata.assets) lines.push(`| ${asset.path.at(-1)} | ${asset.mime} | ${asset.compressed ? 'yes' : 'no'} | ${asset.bytes} | ${asset.filename} |`);
add('', '### Reproduce (no packages, no hardware)',
  '```powershell', 'node --version', 'node design/analysis/dump-kuba.mjs',
  'node design/analysis/envelope.mjs', 'node design/analysis/report-kuba.mjs', '```',
  'The report builder refuses to evaluate changed/unreviewed template code. The dumper still decodes a changed live bundle and records both hashes for review. No decoded source is written into the repository.');

add('## B. KUBA UI FACTS', '### B1. Editing surface and all parameter limits',
  '- Users choose one of **11 fixed Auri presets**: 7 preference curves and 4 reference curves. The reference group is collapsible. There is a single Auri model button. Disco 3 has an empty preset array and dormant empty-state text; no usable Disco presets.',
  '- Each written preset has **10 biquad sections**, but there are **no per-band controls**. Preset selection creates buttons with radio semantics, not a band editor.',
  '| Parameter / control | Minimum | Maximum | Step | Editable? |',
  '|---|---|---|---|---|',
  '| Frequency slider / numeric input | not found | not found | not found | no |',
  '| Gain slider / numeric input | not found | not found | not found | no |',
  '| Q slider / numeric input | not found | not found | not found | no |',
  '| Preamp slider / numeric input | not found | not found | not found | no |',
  '| Filter-kind selector | not found | not found | not found | no |',
  '- PK and LS occur in preset data and the serializer. **No UI filter types are offered.** HS, LP, HP, notch, band-pass, all-pass and OFF are not found as official app options or implementations.',
  '- Serializer dispatch is LS if the type is LS, otherwise PK; that fallback is not evidence that other named kinds are implemented.',
  `- Static element/call scan (also asserted by the helper): \`${JSON.stringify(scan)}\`.`,
  '- Chart constants 20 and 20,000 Hz, chart-axis 5 dB grid/padding and the −20 dB chart floor are **not** editable parameter limits or DSP safety clamps.');
evidence('preset selection buttons, not band editing', [[430, 437]]);
evidence('only implemented section design dispatch and section-count validation', [[270], [276, 277]]);

add('### B2. Validation, clamping, ordering, preamp and solver',
  '- `blob` rejects a band count other than 10 and a rounded Q27 coefficient outside signed int32. It builds a 220-byte payload with Q23 preamp and five Q27 words per section; CRC16 is appended.',
  '- No parameter min/max/Q clamp, finite-number check, positive-preamp rejection, pole-stability/Jury check, whole-cascade gain check or transient clipping check is found in the official app. Its safety surface is chiefly the fixed reviewed literals, not general-purpose input validation.',
  '- The preamp is a fixed `pre` number on each preset. **Automatic preamp computation is not found.** The serializer converts that number to linear Q23 and uses a falsy-to-zero fallback; it does not derive preamp from a response peak.',
  '- All 11 literal band arrays already put negative-gain sections before positive-gain sections. This was checked programmatically. **Runtime sorting is not found**; the comment describes the preset design, not a sorting function. The writer preserves array order.',
  '- Commented intent: preamps match preset volume over 300 Hz–3 kHz, avoiding clipping via cuts before boosts. Runtime chart normalization also computes an unweighted arithmetic mean in that interval, but operates only on a displayed curve.',
  '- ISO 226/equal-loudness contour weighting, an AutoEQ-like fitting solver/optimization loop, target-to-filter fitting UI, and import/export of user EQ are **not found**. Embedded preset/measurement/target arrays and closed-form PK/LS coefficient design are not a solver.',
  '- The repository codec credits AutoEq coefficient arithmetic; that is not evidence that the official page contains an AutoEq solver.');
evidence('integer range check, preamp conversion, order preservation', [[278, 286]]);
evidence('author comments on design and loudness', [[311, 314]]);

add('### B3. Chart versus actual write (`show` versus `bands`)',
  '- Chart uses raw acoustic measurement + `DSP.response(p.show || p.bands, f)`, then shifts the result by the mean difference from its displayed target over 300 Hz–3 kHz. It does **not** add the written preamp.',
  '- `pref6` / **Natural** has an alternate 10-section `show` array which differs from all 10 corresponding sent `bands`. Only that preset has `show`. Its pretty chart is therefore not a plot of the actual programmed cascade.',
  '- HID write always uses the actual `bands` and `pre`, never `show`.',
  '- Harman uses the Harman plotted target. All other presets are displayed against the default JM-1 target, even when their `target` metadata says Basshead, Analítico or Referência. These target arrays/labels are chart data, not device-side preset IDs.',
  '- The chart is an acoustically measured/target-aligned visualization, not an electrical headroom meter, a readback, or proof against clipping.');
evidence('alternate Natural display/sent arrays', [[320, 323]]);
evidence('display target and arithmetic-mean normalization', [[364, 372]]);
evidence('actual serialization/write inputs', [[476, 478]]);

add('### B4. Complete WebHID flow and on-device storage',
  '- Constants: VID **0x3302**, PID **0x8902**, report ID **0xCB**, coefficient sample rate **96,000 Hz**.',
  '- On load, if WebHID exists, call `getDevices`, find that VID/PID and open an already-authorized device. On explicit connect/apply, repeat `getDevices`; if none matches, call `requestDevice` with exactly one VID/PID filter and no usage/usagePage filter; use first returned device; open it if necessary.',
  '- Two `sendReport` call sites only: (1) a loop transmitting 9 data reports of 31 bytes, report ID 0xCB, indexes 0–8; (2) a single bare **5-byte** commit report, same report ID, bytes **01 65 00 01 FF**.',
  '- Each data report has 1 index byte + 30 payload bytes, padded with zeroes. The payload is 220 bytes; all data frames carry 270 payload/padding bytes total. Report 7 contains the final 10 payload bytes then 20 zeroes; report 8 contains 30 zeroes.',
  '- Delay **16 ms after each data report**, including report 8, then an additional **150 ms** before commit: the last data completion is at least **166 ms** before commit starts. Nominal intentional sleeps total **294 ms** for the complete sequence, excluding transfer/scheduling time. No post-commit delay/acknowledgment is found.',
  '- `sendFeatureReport`, `receiveFeatureReport`, `receiveReport`, `oninputreport` / input-report listeners, status/preset readback, other report commands, slot selection, factory reset and firmware-update commands: **not found**.',
  '- A HID disconnect listener clears the local device reference and updates the UI. There is no explicit device close or forget action.',
  '- The page says applying persists the curve in the cable and it subsequently works on any host. It confirms the current curve will be replaced. The code writes one current configuration; **device-side preset slots and a slot-addressing command are not found**. Internal flash organization cannot be determined from this page.',
  '- The “Aplicado” tag is based on browser localStorage key `kuba-applied-` + model, set immediately after the commit send resolves. It is not device readback, a per-serial record or a verified commit acknowledgment. Other local keys store model and whether the reference section is expanded.');
evidence('protocol constants', [[255, 258]]);
evidence('connection and exact request filters', [[458, 467]]);
evidence('packet framing', [[293, 296]]);
evidence('write sequence and success/failure handling', [[470, 485]]);
evidence('local display state versus readback', [[424], [434, 435], [497], [503]]);

add('### B5. Warnings, disclaimers, language and credits',
  '- UI language: **Portuguese (Brazilian wording)**; product and community target names remain as names.',
  '- Browser/platform notice: desktop Chrome/Edge on Windows, Mac or Linux; mobile phones, tablets and Safari cannot access the cable. Once stored in the cable, the curve also works on a phone.',
  '- Destructive-replacement confirmation before writing, with “Gravar no cabo” and “Cancelar” buttons.',
  '- Error/status text covers no WebHID support, no cable selected, device-open failure, write failure/replug/retry, disconnection and successful writing. Exact text below.',
  '- Reference-category disclaimer explicitly acknowledges Harman is itself a preference curve and explains community use as a comparison ruler.',
  '- Hearing-safety / reduce-volume / unsupported-arbitrary-EQ / clipping-risk / firmware-warranty or legal disclaimer: **not found**. Do not infer a broad safety guarantee from the short “sem clipping” author comment.',
  '- Visible brand credit: Kuba. Source-only credit: the default filters are Leonardo’s; protocol comment mentions TTGK “USB DSP Audio”, Walkplay family. Displayed reference names include JM-1, Harman IE 2019, VDSF and Etymotic. An explicit AutoEq/ISO226 solver credit and a code licence statement are **not found**.');
evidence('reference-category disclaimer', [[228]]);
evidence('desktop support and cable persistence notice', [[234]]);
evidence('confirmation button labels', [[241, 242]]);
evidence('replace-current-curve warning', [[492]]);
evidence('no-HID / no-selection / open error text', [[459], [464], [466, 467]]);
evidence('write and disconnect status text', [[475], [482, 484], [497], [502]]);
evidence('source-only protocol and author credits', [[253], [311, 312]]);

add('### B6. Full preset list and exact UI display labels',
  'Auri model; preference heading “Curvas de preferência”, reference heading “Curvas de referência”. `padrao` displays “Auri”, not “Padrão”; `pref6` displays “Natural”; `emv` displays “Em V”.',
  '| Key | UI group | Display label | Description | Written preamp dB | `target` metadata | `show` override? | Source line |',
  '|---|---|---|---|---:|---|---|---:|');
for (const p of reference.presets.auri) {
  const sourceIndex = sourceLines.findIndex((line) => line.includes(`{id:'${p.id}'`)) + 1;
  lines.push(`| ${p.id} | ${p.group === 'pref' ? 'Curvas de preferência' : 'Curvas de referência'} | ${p.name} | ${p.desc} | ${p.pre} | ${p.target} | ${p.show ? 'yes (chart only)' : 'no'} | template.html:${sourceIndex} |`);
}
add('', 'The two arrays have 11 Auri entries and 0 Disco entries. Every Auri entry has 10 sent bands. There is no hidden user-defined/neutral/reset preset in this list.');

add('## C. ENVELOPE NUMBERS',
  '- Full numeric appendix follows section D below; all 110 section rows and every prefix stage are included.',
  '- Repository outputs: `design/analysis/envelope.json` (full binary64 numeric values, all coefficients/words, float and Q27 poles, all peak frequencies and per-domain/per-order stage results) and `design/analysis/envelope.md` (readable numeric appendix).',
  '- Asserted: all **11** repo-codec payloads equal fixtures exactly; all **11** live official payloads and nine-report arrays equal those same fixtures; all **110** sections are stable after Q27 quantization; **880** response evaluations agree with the codec.',
  '- Documentation method is the maximum frequency response of **every cascade prefix with the preamp included**, not the sum of individual sections’ independent maxima. The prefixes may reach their peaks at different frequencies.',
  `- Validated published worst internal peaks: **${numbers.validation.measuredOrderWorst.reference.db.toFixed(9)} dB → −0.20**, **${numbers.validation.measuredOrderWorst.frequency.db.toFixed(9)} dB → +4.79**, and **${numbers.validation.measuredOrderWorst.reversed.db.toFixed(9)} dB → +9.13**. Counts over 0 dB are 0 / 7 / 11, matching the docs.`,
  '- Every section’s max absolute coefficient and fraction of 16, float/quantized pole radius and distance to the unit circle, and standalone peak are listed in the appendix. Exact positive signed-int32 Q27 ceiling is 15.999999992549419; −16 itself is representable. The task’s symmetric |coef| ≥ 16 warning threshold is conservative.',
  '- **Editable-range corner/grid sweep: not applicable.** No frequency/gain/Q/preamp editable ranges or UI kind selector exist. No Cartesian product can be inferred from a preset-only UI. Arbitrary min/max-box tests would be extrapolation, not official write evidence.',
  '- Both 20–48 kHz and the stricter DC–48 kHz are computed, to remove ambiguity in “up to 48 kHz”. Pole-radius safety uses the quantized denominator, including real-pole cases, not merely sqrt(a2) for every filter.');

add('## D. Evidence-based safety observations',
  '### What is actually proven by the official tool',
  '1. It offers the **11 exact tuples (ordered ten-section band list, preamp)** and sends the bytes represented in the fixture. Natural is its actual `bands` tuple, not its display `show` tuple. All 11 match the live pinned code byte-for-byte.',
  '2. Across these fixed tuples, the **marginal** ranges are PK frequency 20–15,808 Hz / gain −12…+9.2 dB / Q 0.1–4; LS frequency 120–297 Hz / gain −9.3…+8.2 dB / Q 0.44–0.94; preamp −7.8…−0.5 dB. These are sampled extrema, **not user-settable ranges** and not proof of their cross-products.',
  '3. Only PK and LS are evidenced. The format may mathematically encode other stable biquads, and this repository can design more types, but this page does not establish their firmware acceptance or their practical audio safety.',
  '### Numeric envelope and its limits',
  '- Max absolute coefficient is **1.9973274166228203** (12.483296353892627% of 16), while max pole radius is **0.9998684388535959** float / **0.99986846753918** Q27 (Musical stage 1). The controlling coefficient and controlling pole occur in different sections.',
  '- This is substantial **coefficient-storage** margin, not a guarantee of accumulator/state headroom or a licence to increase gain proportionally. Coefficient magnitudes, pole radius and cascade output/internal headroom are separate constraints.',
  '- In 20 Hz–20 kHz (and also 20 Hz–48 kHz), worst prefix is Harman stage 1 at **−0.2037018755880073 dB**; worst final output is Auri at **−0.4709263300099278 dB**. Q27/Q23 counterparts are **−0.20368875272918074 dB** and **−0.47087539615209006 dB**.',
  '- Harman’s first stage is a **negative-gain low shelf** but has a resonant hump: its standalone maximum is approximately **+0.296298124 dB** near 428.288765 Hz. Therefore “cuts first” mitigates intermediate gain but even a cut section need not stay ≤ 0 dB at every frequency.',
  '- Across DC–48 kHz, Basshead reaches **+2.499999999446179 dB** at DC (Q27/Q23 **+2.5000638697363913 dB**); the response crosses 0 dB at approximately **7.253020739707905 Hz**. At 5 Hz it is **+1.033275658135688 dB**. The 20 Hz lower cutoff in the earlier envelope hid this subsonic boost.',
  '- DC and subsonic values describe the modeled digital transfer function. Whether an actual host, firmware path or analog output removes those frequencies is **not found** in this page and was not measured.',
  '- The above shows official presets themselves are not a general “never clips” proof: DC/subsonic content, phase/broadband transients and unknown internal arithmetic remain relevant. No device connection or firmware measurement was performed.',
  '### Risky changes / combinations not established by the official page',
  '- Reordering the exact bands by frequency raises the worst prefix peak to **+4.789767181921063 dB**; reversing them raises it to **+9.133110579175554 dB**. Preserve actual array order, not chart order or a canonical sort.',
  '- Independent edits that combine fixture marginal extrema, stacking several maximum boosts, mixing bands between presets, changing fixed preamps, using positive preamp, pushing Q/frequency to new values, or introducing HS/LP/HP/OFF are **not proven by this UI**. A coefficient/pole check alone cannot certify these cascades against clipping.',
  '- A coefficient-position bounding box formed from the table does not certify arbitrary points in it: denominator stability and transfer peaks depend jointly on coefficients. A radius no larger than the sampled maximum is only a conservative similarity policy, not a demonstrated firmware boundary.',
  '- For an expanded experimental editor, keep strict quantized overflow/stability checks, preserve/optimize write order, evaluate every prefix with preamp across the intended full bandwidth, reserve additional broadband/transient headroom, and distinguish “mathematically acceptable” from “officially written” in UI and policy. Those are engineering recommendations, not hardware-certified limits.',
  '- Evidence does **not** support silently broadening official-safe parameter ranges. The strongest official-safe allowlist remains the 11 exact presets. The computed envelope is useful for conservative monitoring/experimentation but not a substitute for measured hardware characterization.');
add('## Verification and limitations',
  '- All manifest entries decoded and decoded hashes/byte lengths rechecked.',
  '- Full inline application source inspected, including rendering, connection, write and boot paths; no device interaction performed.',
  '- Offline assertions compare live pinned source → fixture and repository codec → fixture; no installed dependencies.',
  '- Source absence findings apply to this fetched/pinned version, not other Kuba tools or firmware.',
  '- Frequency extrema are dense-grid plus local refinement estimates, not formally certified interval bounds. They reproduce the three requested published two-decimal values before any envelope conclusion is used.',
  '- No repository source/tests/tools/docs/package manifest were modified; only helper scripts and derived numerical outputs under `design/analysis/` are created by this work.',
  '---', '# Numeric appendix (full section and cascade tables)',
  numericAppendix);
const reportPath = resolve(directory, 'kuba-analysis.md');
await writeFile(reportPath, lines.join('\n'));
console.log(JSON.stringify({ reportPath, reportLines: lines.join('\n').split('\n').length,
  assetsVerified: metadata.assets.length, livePresetsVerified: reference.presets.auri.length,
  fixturePayloadsVerified: numbers.validation.exactFixturePayloads, scan }, null, 2));
