// YOLO publication, option B: a real, committed YOLO write dispatches `cable:written` like any
// other, marked (`profile: 'yolo'` and the waived codes), so the app marks the curve as written
// and the outbox counts the install. Simulated writes still dispatch nothing.
import { describe, expect, test } from 'vitest';
import { NEUTRAL_BANDS } from 'open-auri/dsp';
import { gateForWrite } from 'open-auri/safety';
import type { Band } from '../../../src/lib/cable/types.ts';
import { CONFIRMED, TRUSTED_CLICK, padrao, setup } from './harness.ts';

type Harness = Awaited<ReturnType<typeof setup>>;

/** Refused by the standard gate on class-2 reasons only, accepted by YOLO: HP 30 Hz. */
const YOLO_BANDS: Band[] = [{ kind: 'HP', freqHz: 30, qFactor: 0.71 }, ...NEUTRAL_BANDS.slice(1)];
const YOLO_PREAMP = -0.5;

function writeYolo(h: Harness) {
	return h.service.write({
		bands: YOLO_BANDS,
		preampDb: YOLO_PREAMP,
		experimental: true,
		profile: 'yolo',
		confirmations: { ...CONFIRMED, experimental: true, yoloWrite: true },
		gesture: h.service.createGesture(TRUSTED_CLICK),
		name: 'Subsônica'
	});
}

describe('cable:written for YOLO writes', () => {
	test('the fixture is YOLO-only', () => {
		expect(gateForWrite(YOLO_BANDS, YOLO_PREAMP, { experimental: true }).ok).toBe(false);
		const yolo = gateForWrite(YOLO_BANDS, YOLO_PREAMP, { experimental: true, profile: 'yolo' });
		expect(yolo.ok).toBe(true);
		expect(yolo.waived?.length ?? 0).toBeGreaterThan(0);
	});

	test('a real YOLO write dispatches one marked cable:written event', async () => {
		const h = await setup({ yoloSession: true });
		const outcome = await writeYolo(h);
		expect(outcome.status).toBe('ok');
		expect(h.journal.entries).toHaveLength(1);
		expect(h.journal.entries[0]).toMatchObject({ status: 'ok', profile: 'yolo' });
		expect(h.written).toHaveLength(1);
		const { waived } = gateForWrite(YOLO_BANDS, YOLO_PREAMP, {
			experimental: true,
			profile: 'yolo'
		});
		expect(h.written[0]).toMatchObject({
			profile: 'yolo',
			waived,
			preampDb: YOLO_PREAMP,
			bands: YOLO_BANDS
		});
		expect(h.written[0]?.entry.profile).toBe('yolo');
	});

	test('a standard write stays unmarked', async () => {
		const h = await setup();
		await h.service.write({
			bands: padrao.eqBands,
			preampDb: padrao.preampDb,
			experimental: false,
			confirmations: CONFIRMED,
			gesture: h.service.createGesture(TRUSTED_CLICK),
			name: 'Padrão'
		});
		expect(h.written).toHaveLength(1);
		expect(h.written[0]?.profile).toBeUndefined();
		expect(h.written[0]?.waived).toBeUndefined();
	});

	test('without the YOLO session nothing is written and nothing dispatched', async () => {
		const h = await setup({ yoloSession: false });
		const outcome = await writeYolo(h);
		expect(outcome.status).not.toBe('ok');
		expect(h.device.sent).toEqual([]);
		expect(h.written).toEqual([]);
	});

	test('a simulated YOLO write journals simulated and dispatches nothing', async () => {
		const h = await setup({ hid: null, yoloSession: true });
		await h.service.connect();
		await writeYolo(h);
		expect(h.journal.entries.map((entry) => entry.status)).toEqual(['simulated']);
		expect(h.flash.records).toEqual([]);
		expect(h.written).toEqual([]);
	});
});
