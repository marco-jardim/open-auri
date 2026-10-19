/**
 * YOLO publication, client phase A: the publication rules the client follows (acknowledgement,
 * 409/403 answers), the badges of stored curves, the library archive and merge, the Comunidade
 * model, and the Terms (amended, POLICY_VERSION bumped).
 */
import { describe, expect, test } from 'vitest';
import { NEUTRO } from 'open-auri/catalog';
import { encodeS1, parseEnvelope } from 'open-auri/share';
import {
	ackWaived,
	curveBadge,
	needsYoloAck,
	waivedLabels,
	yoloPublishBlock,
	yoloPublishText
} from '#lib/components/yolo/yolo-curve.ts';
import { archiveTapes, envelopeView, tapeBadge } from '#lib/components/pages/biblioteca/archive.ts';
import { MERGE_BATCH, mergeBatches, mergeWeight } from '#lib/components/pages/biblioteca/social.ts';
import { errorText } from '#lib/components/pages/comunidade/model.ts';
import { POLICY_VERSION } from '#lib/content/legal/version.ts';
import { termsEnUS } from '#lib/content/legal/terms.en-US.ts';
import { termsPtBR } from '#lib/content/legal/terms.pt-BR.ts';
import { m } from '#lib/paraglide/messages.js';
import { SocialApiError } from '#lib/social/api.ts';
import type { LibraryItem } from '#lib/state/library.svelte.ts';
import { neutralCurve } from '#lib/state/model.ts';

const neutral = neutralCurve();
const yoloBands = [{ kind: 'HP' as const, freqHz: 30, qFactor: 0.71 }, ...NEUTRO.bands.slice(1)];
const yoloCurve = { bands: yoloBands, preampDb: -0.5 };
const boost = { kind: 'PK' as const, freqHz: 1000, gainDb: 9, qFactor: 1 };
const rejectedCurve = {
	bands: [boost, boost, boost, boost, ...NEUTRO.bands.slice(4)],
	preampDb: -0.5
};

function localItem(id: string, curve: Pick<LibraryItem, 'bands' | 'preampDb'>): LibraryItem {
	return {
		...neutral,
		...curve,
		id,
		name: id,
		source: 'custom',
		s1: encodeS1(curve),
		favorite: false,
		createdAt: 1760000000000,
		updatedAt: 1760000000000
	};
}

describe('publication rules', () => {
	test('only a YOLO curve opened to others needs the acknowledgement', () => {
		expect(needsYoloAck(true, 'public')).toBe(true);
		expect(needsYoloAck(true, 'unlisted')).toBe(true);
		expect(needsYoloAck(true, 'private')).toBe(false);
		expect(needsYoloAck(false, 'public')).toBe(false);
	});

	test('409 asks for the step, 403 off and account-age say why, anything else is not YOLO', () => {
		const ack = new SocialApiError(409, 'YOLO_ACK_REQUIRED', { waived: ['a:b2', 7] });
		expect(yoloPublishBlock(ack)).toBe('ack');
		expect(ackWaived(ack)).toEqual(['a:b2']);
		expect(yoloPublishBlock(new SocialApiError(403, 'YOLO_PUBLICATION_OFF'))).toBe('off');
		expect(yoloPublishBlock(new SocialApiError(403, 'FORBIDDEN', { reason: 'account-age' }))).toBe(
			'account-age'
		);
		expect(yoloPublishBlock(new SocialApiError(403, 'FORBIDDEN'))).toBeNull();
		expect(yoloPublishBlock(new SocialApiError(422, 'GATE_REJECTED'))).toBeNull();
		expect(yoloPublishBlock(new Error('x'))).toBeNull();
		expect(ackWaived(new SocialApiError(409, 'YOLO_ACK_REQUIRED'))).toEqual([]);
		expect(yoloPublishText('off')).toBe(
			'Publicação de curvas YOLO ainda está desligada; salve como privada.'
		);
		expect(yoloPublishText('account-age')).toBe(m.yolopub_error_account_age());
	});

	test('the Comunidade error text knows the YOLO answers', () => {
		expect(errorText(new SocialApiError(403, 'YOLO_PUBLICATION_OFF'))).toBe(m.yolopub_error_off());
		expect(errorText(new SocialApiError(403, 'FORBIDDEN', { reason: 'account-age' }))).toBe(
			m.yolopub_error_account_age()
		);
		expect(errorText(new SocialApiError(409, 'YOLO_ACK_REQUIRED'))).toBe(m.yolopub_error_ack());
		expect(errorText(new SocialApiError(403, 'FORBIDDEN'))).toBe(m.comunidade_error_not_found());
	});

	test('waived codes read as lamp names, once each', () => {
		const labels = waivedLabels(['a:b2', 'a:neg-a2', 'd7:boost-q']);
		expect(labels).toHaveLength(2);
		expect(labels.every((label) => label.trim() !== '')).toBe(true);
		expect(waivedLabels(undefined)).toEqual([]);
	});
});

describe('badges', () => {
	test('stored curves: YOLO, warn (refused today) or none', () => {
		expect(curveBadge({ gateOk: false, yolo: true })).toBe('yolo');
		expect(curveBadge({ gateOk: false, yolo: false })).toBe('warn');
		expect(curveBadge({ gateOk: false })).toBe('warn');
		expect(curveBadge({ gateOk: true, yolo: false })).toBe('none');
	});

	test('library tapes take their badge from their own bands', () => {
		expect(tapeBadge(yoloCurve)).toBe('yolo');
		expect(tapeBadge(rejectedCurve)).toBe('warn');
		expect(tapeBadge(neutral)).toBe('none');
	});

	test('a YOLO tape exports as it is (no marker in S5); a rejected tape is view-only', () => {
		const [, yoloTape, rejectedTape] = archiveTapes([
			localItem('plain', neutral),
			localItem('subsonica', yoloCurve),
			localItem('loud', rejectedCurve)
		]).slice(-3);
		if (!yoloTape || !rejectedTape) throw new Error('missing tapes');
		const draft = envelopeView(yoloTape, 'pt-BR', 'CC0-1.0');
		expect(draft).toMatchObject({ exportable: true, yolo: true });
		const parsed = parseEnvelope(draft.json);
		expect(parsed.ok).toBe(true);
		expect(draft.json.toLowerCase()).not.toContain('yolo');
		expect(envelopeView(rejectedTape, 'pt-BR', 'CC0-1.0')).toMatchObject({
			exportable: false,
			yolo: false
		});
	});
});

describe('library merge', () => {
	test('a YOLO item costs two gate runs; batches stay within the server budget', () => {
		const yoloS1 = encodeS1(yoloCurve);
		const plainS1 = encodeS1(neutral);
		expect(mergeWeight({ s1: yoloS1 })).toBe(2);
		expect(mergeWeight({ s1: plainS1 })).toBe(1);
		expect(mergeWeight({ s1: 'not-a-code' })).toBe(1);
		const items = [
			...Array.from({ length: 15 }, (_, index) => ({ localId: `y${index}`, s1: yoloS1 })),
			...Array.from({ length: 5 }, (_, index) => ({ localId: `p${index}`, s1: plainS1 }))
		];
		const batches = mergeBatches(items);
		expect(batches.flat()).toEqual(items);
		for (const batch of batches) {
			const cost = batch.reduce((sum, item) => sum + mergeWeight(item), 0);
			expect(cost).toBeLessThanOrEqual(MERGE_BATCH);
		}
		// 10 YOLO items (20 runs), then 5 YOLO and 5 standard ones (15 runs).
		expect(batches.map((batch) => batch.length)).toEqual([10, 10]);
		// Standard items only: the unchanged batches of 20.
		const plain = Array.from({ length: 41 }, (_, index) => ({ localId: `q${index}`, s1: plainS1 }));
		expect(mergeBatches(plain).map((batch) => batch.length)).toEqual([20, 20, 1]);
	});
});

describe('Terms', () => {
	test('POLICY_VERSION is bumped for the YOLO terms', () => {
		expect(POLICY_VERSION).toBe('2026-10-19');
	});

	test('both locales say YOLO does not get around the gate and describe YOLO curves', () => {
		const pt = JSON.stringify(termsPtBR);
		const en = JSON.stringify(termsEnUS);
		expect(pt).toContain('o Modo YOLO não contorna o gate');
		expect(pt).toContain('**Curvas YOLO.**');
		expect(pt).toContain('Quem grava uma curva YOLO no cabo assume o risco.');
		expect(en).toContain('YOLO mode does not circumvent the gate');
		expect(en).toContain('**YOLO curves.**');
		expect(en).toContain('Whoever writes a YOLO curve to the cable takes on the risk.');
		expect(en).not.toContain('sondar-placeholder');
		// The version line interpolates POLICY_VERSION (the docs/legal lines must match it too).
		expect(pt).toContain(POLICY_VERSION);
		expect(en).toContain(POLICY_VERSION);
	});
});
