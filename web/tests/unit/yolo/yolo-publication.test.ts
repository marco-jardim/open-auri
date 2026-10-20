/**
 * YOLO publication, client phase A: the publication rules the client follows (acknowledgement,
 * 409/403 answers), the badges of stored curves, the library archive and merge, the Comunidade
 * model, and the Terms (amended, POLICY_VERSION bumped).
 */
import { describe, expect, test, vi } from 'vitest';
import { NEUTRO } from 'open-auri/catalog';
import { decodeS1, encodeS1, parseEnvelope } from 'open-auri/share';
import { classifiedCurve } from '#lib/gate-verdicts.ts';
import {
	ackWaived,
	curveBadge,
	needsYoloAck,
	waivedLabels,
	yoloPublishBlock,
	yoloPublishText
} from '#lib/components/yolo/yolo-curve.ts';
import { archiveTapes, envelopeView, tapeBadge } from '#lib/components/pages/biblioteca/archive.ts';
import {
	MERGE_BATCH,
	mergeBatches,
	mergeWeight,
	type MergeClassify
} from '#lib/components/pages/biblioteca/social.ts';
import { errorText } from '#lib/components/pages/comunidade/model.ts';
import { POLICY_VERSION } from '#lib/content/legal/version.ts';
// The server module (workerd only) is read as text: the Terms must state its thresholds.
import moderationSource from '../../../src/lib/server/social/moderation.ts?raw';
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
	test('a YOLO item costs two gate runs; batches stay within the server budget', async () => {
		const yoloS1 = encodeS1(yoloCurve);
		const plainS1 = encodeS1(neutral);
		expect(mergeWeight({ s1: yoloS1 })).toBe(2);
		expect(mergeWeight({ s1: plainS1 })).toBe(1);
		expect(mergeWeight({ s1: 'not-a-code' })).toBe(1);
		const items = [
			...Array.from({ length: 15 }, (_, index) => ({ localId: `y${index}`, s1: yoloS1 })),
			...Array.from({ length: 5 }, (_, index) => ({ localId: `p${index}`, s1: plainS1 }))
		];
		const batches = await mergeBatches(items);
		expect(batches.flat()).toEqual(items);
		for (const batch of batches) {
			const cost = batch.reduce((sum, item) => sum + mergeWeight(item), 0);
			expect(cost).toBeLessThanOrEqual(MERGE_BATCH);
		}
		// 10 YOLO items (20 runs), then 5 YOLO and 5 standard ones (15 runs).
		expect(batches.map((batch) => batch.length)).toEqual([10, 10]);
		// Standard items only: the unchanged batches of 20.
		const plain = Array.from({ length: 41 }, (_, index) => ({ localId: `q${index}`, s1: plainS1 }));
		expect((await mergeBatches(plain)).map((batch) => batch.length)).toEqual([20, 20, 1]);
	});

	test('the weight is the gate runs of the classification, not its class', () => {
		for (const curve of [yoloCurve, rejectedCurve, neutral]) {
			const s1 = encodeS1(curve);
			const decoded = decodeS1(s1);
			expect(mergeWeight({ s1 })).toBe(classifiedCurve(decoded.bands, decoded.preampDb).gateRuns);
		}
	});

	test('the weights never block the page: one task per item, or the worker', async () => {
		const yoloS1 = encodeS1(yoloCurve);
		const plainS1 = encodeS1(neutral);
		const items = [
			{ localId: 'y', s1: yoloS1 },
			{ localId: 'p', s1: plainS1 },
			{ localId: 'x', s1: 'not-a-code' }
		];
		// Main thread: the page gets a task between two items (a timer queued now fires first).
		const order: string[] = [];
		const pending = mergeBatches(items).then((batches) => {
			order.push('batches');
			return batches;
		});
		setTimeout(() => order.push('page'), 0);
		expect(order).toEqual([]);
		expect((await pending).flat()).toEqual(items);
		expect(order).toEqual(['page', 'batches']);
		// Through the worker (`classify`): no main-thread classification at all.
		const classify = vi.fn<MergeClassify>(async (curve) =>
			curve.bands[0]?.kind === 'HP'
				? { classification: { class: 'yolo', waived: [], reasons: [] }, gateRuns: 2 }
				: { classification: { class: 'standard', waived: [], reasons: [] }, gateRuns: 1 }
		);
		const batches = await mergeBatches(items, { classify });
		expect(batches.flat()).toEqual(items);
		// The S1 that does not decode costs 1 without a classification.
		expect(classify).toHaveBeenCalledTimes(2);
		const many = Array.from({ length: 12 }, (_, index) => ({ localId: `y${index}`, s1: yoloS1 }));
		expect((await mergeBatches(many, { classify })).map((batch) => batch.length)).toEqual([10, 2]);
		// Cancelled: the remaining items are not weighed.
		const controller = new AbortController();
		controller.abort();
		await expect(mergeBatches(items, { classify, signal: controller.signal })).rejects.toSatisfy(
			(error: unknown) => error instanceof DOMException && error.name === 'AbortError'
		);
	});
});

describe('Terms', () => {
	test('POLICY_VERSION includes the YOLO terms and Android privacy update', () => {
		expect(POLICY_VERSION).toBe('2026-10-20');
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

	test('the moderation section names both automatic hiding thresholds, YOLO at 2', () => {
		expect(moderationSource).toMatch(/export const AUTO_HIDE_THRESHOLD = 3;/);
		expect(moderationSource).toMatch(/export const YOLO_AUTO_HIDE_THRESHOLD = 2;/);
		const pt = JSON.stringify(termsPtBR);
		const en = JSON.stringify(termsEnUS);
		expect(pt).toContain('quando 3 contas verificadas diferentes');
		expect(pt).toContain('uma curva cuja versão atual é YOLO é ocultada já com 2 dessas contas');
		expect(en).toContain('when 3 different verified accounts');
		expect(en).toContain(
			'a curve whose current version is YOLO is hidden with just 2 such accounts'
		);
	});
});
