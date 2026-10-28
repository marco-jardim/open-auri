/**
 * QA #67/#70 finding 9: a gate refusal from the transport (`applyCurve` throws before any I/O)
 * holds only that curve; a newer pending edit stays scheduled.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { gateForWrite } from 'open-auri/safety';
import type { Band, LiveCurve } from '../../../src/lib/cable/types.ts';
import { TRUSTED_CLICK, off, setup } from './harness.ts';

/** `applyCurve` calls with this preamp wait for `release`, then throw GateRejectedError. */
const REFUSED_PREAMP = -11.5;
const gate = vi.hoisted((): { waiting: Promise<void> } => ({ waiting: Promise.resolve() }));

vi.mock('open-auri/transport', async (importOriginal) => {
	const original = await importOriginal<typeof import('open-auri/transport')>();
	return {
		...original,
		applyCurve: async (...args: Parameters<typeof original.applyCurve>) => {
			if (args[2] === REFUSED_PREAMP) {
				await gate.waiting;
				throw new original.GateRejectedError([]);
			}
			return original.applyCurve(...args);
		}
	};
});

type Harness = Awaited<ReturnType<typeof setup>>;

const OFF_BANDS: Band[] = Array.from({ length: 10 }, off);

function curve(preampDb: number): LiveCurve {
	return { bands: OFF_BANDS, preampDb };
}

function crcOf(preampDb: number): number {
	return Number(gateForWrite(OFF_BANDS, preampDb, { experimental: false }).metrics.payloadCrc);
}

function liveCrc(h: Harness): number | null {
	const payload = h.device.firmware.live;
	if (payload === null) return null;
	return (payload[218] ?? 0) | ((payload[219] ?? 0) << 8);
}

let tabs: Harness[] = [];
afterEach(() => {
	for (const h of tabs) h.service.dispose();
	tabs = [];
});

async function started(): Promise<Harness> {
	const h = await setup();
	tabs.push(h);
	const outcome = await h.service.startLive({
		curve: curve(-12),
		confirmations: { volumeLowered: true },
		gesture: h.service.createGesture(TRUSTED_CLICK)
	});
	expect(outcome.status).toBe('accepted');
	return h;
}

describe('transport gate refusal', () => {
	test('without a newer edit: that curve is held (gate)', async () => {
		gate.waiting = Promise.resolve();
		const h = await started();
		h.service.queueLive(curve(REFUSED_PREAMP));
		await h.service.whenLiveIdle();
		expect(h.service.getState().live).toMatchObject({ status: 'held', hold: { reason: 'gate' } });
		expect(liveCrc(h)).toBe(crcOf(-12));
	});

	test('a newer pending edit stays scheduled and is applied', async () => {
		let release: () => void = () => undefined;
		gate.waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const h = await started();
		h.service.queueLive(curve(REFUSED_PREAMP));
		// Wait until the refused curve is in flight, then edit again.
		await vi.waitFor(() => expect(h.service.getState().live?.status).toBe('applying'));
		h.service.queueLive(curve(-11));
		expect(h.service.getState().live?.pending).toBe(true);
		release();
		await h.service.whenLiveIdle();
		expect(h.service.getState().live).toMatchObject({ status: 'live', hold: null, applies: 2 });
		expect(liveCrc(h)).toBe(crcOf(-11));
	});
});
