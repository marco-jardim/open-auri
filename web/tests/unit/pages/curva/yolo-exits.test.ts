/**
 * YOLO publication, client phase A: every exit is class-based (core `classifyCurve`, cached in
 * gate-verdicts.ts). Standard and YOLO curves leave, YOLO marked (`-yolo` file names, the `.txt`
 * header, the `yolo` flag); rejected curves (class 1, or a preamp below −25,5 dB that S1 cannot
 * encode) are refused. Links, files and imports with a band above 20 kHz load only in
 * Engenharia; an S1 version this build does not know reads as a newer open-auri.
 */
import { describe, expect, test } from 'vitest';
import { NEUTRO } from 'open-auri/catalog';
import { parseEqualizerApo } from 'open-auri/io';
import { encodeS1 } from 'open-auri/share';
import {
	admit,
	exportBin,
	exportS5,
	exportTxt,
	fileName,
	importTxt,
	linkHash,
	readLinkHash,
	yoloTxtHeader
} from '#lib/components/pages/curva/io.ts';
import { ioFailureText } from '#lib/components/pages/curva/io-text.ts';
import { verdictFor, type Band, type Curve } from '#lib/components/pages/curva/model.ts';
import {
	canBringBack,
	classOf,
	exitMark,
	exitReason,
	exitRefusal,
	isYoloCurve,
	standardCurve
} from '#lib/components/pages/curva/yolo.ts';
import { clearGateVerdicts, curveClassification } from '#lib/gate-verdicts.ts';
import { handleGateRequest } from '#lib/workers/gate-handler.ts';
import { createGateWorker } from '#lib/workers/gate-client.ts';
import { m } from '#lib/paraglide/messages.js';

const pad = (active: Band[]): Band[] => [...active, ...NEUTRO.bands.slice(active.length)];
const standard: Curve = {
	bands: pad([{ kind: 'PK', freqHz: 1000, gainDb: -6, qFactor: 1 }]),
	preampDb: -1
};
/** Refused by the standard gate on class-2 reasons only, accepted by YOLO: "subsônica". */
const yolo: Curve = { bands: pad([{ kind: 'HP', freqHz: 30, qFactor: 0.71 }]), preampDb: -0.5 };
/** Four +9 dB boosts on one frequency at −0,5 dB: not even YOLO takes it. */
const boost: Band = { kind: 'PK', freqHz: 1000, gainDb: 9, qFactor: 1 };
const rejected: Curve = { bands: pad([boost, boost, boost, boost]), preampDb: -0.5 };
/** A preamp below −25,5 dB: S1 v1/v2 cannot encode it, so it is never stored. */
const unencodable: Curve = { bands: standard.bands, preampDb: -30 };
/** A cut above 20 kHz (an S1 v2 curve). */
const ultrasonic: Curve = {
	bands: pad([{ kind: 'PK', freqHz: 22000, gainDb: -3, qFactor: 1 }]),
	preampDb: -0.5
};
const meta = { name: 'Curva', source: 'custom', lang: 'pt-BR' as const, now: 0 };
const imported = (curve: Curve) => ({ ...curve, name: null, bands: [...curve.bands] });

test('the fixtures are what they claim', () => {
	expect(classOf(standard).class).toBe('standard');
	expect(classOf(yolo)).toMatchObject({ class: 'yolo', reasons: [] });
	expect(classOf(yolo).waived.length).toBeGreaterThan(0);
	expect(classOf(rejected).class).toBe('rejected');
	expect(classOf(unencodable)).toMatchObject({ class: 'rejected' });
	expect(classOf(unencodable).reasons).toContain('g:preamp');
});

describe('class-based exit rules', () => {
	test('standard and YOLO curves leave; only rejected and unencodable curves are refused', () => {
		expect(exitRefusal(standard)).toBeNull();
		expect(exitRefusal(yolo)).toBeNull();
		expect(exitReason(yolo)).toBeNull();
		for (const curve of [rejected, unencodable]) {
			const refusal = exitRefusal(curve);
			expect(refusal?.kind).toBe('gate');
			expect(refusal?.reasons.length ?? 0).toBeGreaterThan(0);
			expect(exitReason(curve)).toEqual(expect.any(String));
		}
		expect(exitRefusal(unencodable)?.reasons.map((reason) => reason.code)).toContain('g:preamp');
	});

	test('a YOLO curve carries its mark (the waived codes); others none', () => {
		expect(isYoloCurve(yolo)).toBe(true);
		expect(exitMark(yolo)).toEqual({ waived: classOf(yolo).waived });
		expect(exitMark(standard)).toBeNull();
		expect(exitMark(rejected)).toBeNull();
	});

	test('"Trazer para os limites padrão" only offers a curve that passes the standard gate', () => {
		const offer = standardCurve(yolo);
		if (offer !== null) expect(canBringBack(offer)).toBe(true);
		const fromRejected = standardCurve(rejected);
		if (fromRejected !== null) expect(canBringBack(fromRejected)).toBe(true);
		const same = standardCurve(standard);
		expect(same).not.toBeNull();
		if (same) expect(verdictFor(same).ok).toBe(true);
	});
});

describe('marked files', () => {
	test('a YOLO .txt starts with the two-line header and still parses (comments dropped)', () => {
		const result = exportTxt(yolo, 'engenharia', 'pt-BR');
		expect(result).toMatchObject({ ok: true, yolo: true });
		if (!result.ok) throw new Error('YOLO .txt refused');
		const [first, second] = result.value.split('\n');
		const codes = classOf(yolo).waived.join(', ');
		expect(first).toBe(`# open-auri: curva YOLO, fora dos limites padrão (${codes}).`);
		expect(second).toBe('# Nenhum outro programa verifica estes limites.');
		// The EqualizerAPO parser ignores `#` comments: the curve comes back unchanged.
		const parsed = parseEqualizerApo(result.value);
		expect(parsed.preampDb).toBe(yolo.preampDb);
		expect(parsed.bands[0]).toMatchObject({ kind: 'HP', freqHz: 30 });
		const back = importTxt(result.value, 'engenharia');
		expect(back).toMatchObject({ ok: true, yolo: { waived: classOf(yolo).waived } });
	});

	test('the en-US header and a standard .txt without any header', () => {
		const english = yoloTxtHeader(['a:b2'], 'en-US').split('\n');
		expect(english[0]).toBe('# open-auri: YOLO curve, outside the standard limits (a:b2).');
		expect(english[1]).toBe('# No other program checks these limits.');
		const plain = exportTxt(standard, 'ajustar', 'pt-BR');
		expect(plain).toMatchObject({ ok: true, yolo: false });
		if (plain.ok) expect(plain.value).not.toContain('#');
	});

	test('file names end in -yolo for a YOLO curve (.txt, .json, .bin)', () => {
		expect(fileName('Subsônica', 'txt', true)).toBe('subsonica-yolo.txt');
		expect(fileName('Subsônica', 'json', true)).toBe('subsonica-yolo.json');
		expect(fileName('***', 'bin', true)).toBe('open-auri-yolo.bin');
		expect(fileName('Subsônica', 'txt')).toBe('subsonica.txt');
	});

	test('S5, .bin and the link carry a YOLO curve, flagged, with no marker inside', () => {
		const json = exportS5(yolo, meta, 'engenharia');
		expect(json).toMatchObject({ ok: true, yolo: true });
		if (json.ok) expect(json.value.toLowerCase()).not.toContain('yolo');
		const bin = exportBin(yolo);
		expect(bin).toMatchObject({ ok: true, yolo: true });
		if (bin.ok) {
			const payload = verdictFor(yolo, 'yolo').metrics.payload ?? [];
			expect(Array.from(bin.value)).toEqual(Array.from(payload));
		}
		const link = linkHash(yolo, 'engenharia');
		expect(link).toMatchObject({ ok: true, yolo: true });
		if (link.ok) expect(link.value).toBe(`#p=${encodeS1(yolo)}`);
		expect(exportS5(standard, meta, 'ajustar')).toMatchObject({ ok: true, yolo: false });
	});

	test('rejected and unencodable curves are refused on every exit', () => {
		for (const curve of [rejected, unencodable]) {
			expect(exportTxt(curve, 'engenharia')).toMatchObject({ ok: false });
			expect(exportS5(curve, meta, 'engenharia')).toMatchObject({ ok: false });
			expect(exportBin(curve)).toMatchObject({ ok: false, error: 'gate' });
			expect(linkHash(curve, 'engenharia')).toMatchObject({ ok: false });
			expect(admit(imported(curve), 'engenharia')).toMatchObject({ ok: false });
		}
		expect(exportTxt(rejected, 'engenharia')).toMatchObject({ ok: false, error: 'gate' });
	});
});

describe('loading', () => {
	test('a YOLO link loads (with its mark) whether or not YOLO is on', () => {
		const result = readLinkHash(`#p=${encodeS1(yolo)}`, 'engenharia');
		expect(result).toMatchObject({ ok: true, yolo: { waived: classOf(yolo).waived } });
		expect(readLinkHash(`#p=${encodeS1(standard)}`, 'ajustar')).toMatchObject({
			ok: true,
			yolo: null
		});
	});

	test('a band above 20 kHz loads and leaves only in Engenharia', () => {
		for (const layer of ['ouvir', 'ajustar'] as const) {
			expect(admit(imported(ultrasonic), layer)).toMatchObject({
				ok: false,
				error: 'ultrasonic-layer'
			});
			expect(linkHash(ultrasonic, layer)).toMatchObject({ ok: false, error: 'ultrasonic-layer' });
			expect(exportTxt(ultrasonic, layer)).toMatchObject({ ok: false, error: 'ultrasonic-layer' });
			expect(exportS5(ultrasonic, meta, layer)).toMatchObject({
				ok: false,
				error: 'ultrasonic-layer'
			});
			expect(readLinkHash(`#p=${encodeS1(ultrasonic)}`, layer)).toMatchObject({
				ok: false,
				error: 'ultrasonic-layer'
			});
		}
		const engenharia = admit(imported(ultrasonic), 'engenharia');
		expect(engenharia.ok ? null : engenharia.error).not.toBe('ultrasonic-layer');
		expect(ioFailureText({ ok: false, error: 'ultrasonic-layer', reasons: [] })).toBe(
			'Filtros acima de 20 kHz só entram na camada Engenharia'
		);
	});

	test('an S1 version this build does not know reads as a newer open-auri', () => {
		expect(ioFailureText({ ok: false, error: 'link', reasons: [], detail: 's1:version' })).toBe(
			'Este link é de uma versão mais nova do open-auri'
		);
		expect(ioFailureText({ ok: false, error: 'link', reasons: [], detail: 's1:crc' })).toBe(
			m.curva_io_error_link()
		);
	});
});

describe('client classification', () => {
	test('cached by signature, with experimental derived from the curve', () => {
		clearGateVerdicts();
		const first = curveClassification(yolo.bands, yolo.preampDb);
		expect(curveClassification([...yolo.bands], yolo.preampDb)).toBe(first);
		expect(first.class).toBe('yolo');
		// HS/LP/HP within the limits are standard (experimental derived, as on the server).
		const hs: Curve = {
			bands: pad([{ kind: 'HS', freqHz: 8000, gainDb: -3, qFactor: 0.7 }]),
			preampDb: -1
		};
		expect(curveClassification(hs.bands, hs.preampDb).class).toBe('standard');
	});

	test('the gate worker answers a classify request (pure handler and the fallback client)', async () => {
		expect(
			handleGateRequest({ id: 7, type: 'classify', bands: yolo.bands, preampDb: yolo.preampDb })
		).toEqual({ type: 'classify', id: 7, classification: classOf(yolo) });
		const client = createGateWorker({ worker: false });
		try {
			const answer = await client.classify({ bands: rejected.bands, preampDb: rejected.preampDb });
			expect(answer.classification.class).toBe('rejected');
		} finally {
			client.dispose();
		}
	});
});
