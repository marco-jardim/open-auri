import { afterEach, describe, expect, test, vi } from 'vitest';
import { NEUTRAL_BANDS, USB_PID, USB_VID } from 'open-auri/dsp';
import { createFakeClock } from 'open-auri/transport';
import { evaluateChecklist } from '#lib/cable/checklist.ts';
import { createCableService, NEUTRAL_CURVE } from '#lib/cable/service.ts';
import { NativeHID, type OpenAuriUsbPlugin } from '#lib/cable/native/hid.ts';
import { NativeFreshnessError } from '#lib/cable/native-freshness.ts';
import type { Band, ChecklistContext, ChecklistInput, JournalEntry } from '#lib/cable/types.ts';
import { CONFIRMED, T0, TRUSTED_CLICK, memoryFlash, memoryJournal, padrao } from './harness.ts';

const YOLO_BANDS: Band[] = [{ kind: 'HP', freqHz: 30, qFactor: 0.71 }, ...NEUTRAL_BANDS.slice(1)];
const SHELF_BANDS: Band[] = [
	{ kind: 'HS', freqHz: 8000, gainDb: -3, qFactor: 0.7 },
	...NEUTRAL_BANDS.slice(1)
];

function input(overrides: Partial<ChecklistInput> = {}): ChecklistInput {
	return {
		bands: padrao.eqBands,
		preampDb: padrao.preampDb,
		experimental: false,
		confirmations: { ...CONFIRMED },
		...overrides
	};
}

function context(overrides: Partial<ChecklistContext> = {}): ChecklistContext {
	return {
		cableMode: 'native',
		androidWriteValidated: false,
		nowMs: T0,
		flash: memoryFlash().get(),
		lastWrittenLevelDb: null,
		sessionWriteCount: 0,
		lastJournalStatus: null,
		...overrides
	};
}

describe('Android checklist acknowledgement', () => {
	test.each(['real', 'simulated'] as const)('%s has exactly the old items and outcomes', (mode) => {
		const desktop = evaluateChecklist(input(), context({ cableMode: mode }));
		expect(desktop.items.map(({ id, required }) => ({ id, required }))).toEqual([
			{ id: 'gate', required: true },
			{ id: 'volume', required: true },
			{ id: 'connection', required: true },
			{ id: 'experimental', required: false },
			{ id: 'spacing', required: true },
			{ id: 'yolo-session', required: false },
			{ id: 'yolo-write', required: false }
		]);
		expect(desktop.canWrite).toBe(true);
		for (const androidWriteValidated of [false, true]) {
			for (const androidUntested of [false, true]) {
				expect(
					evaluateChecklist(
						input({ confirmations: { ...CONFIRMED, androidUntested } }),
						context({ cableMode: mode, androidWriteValidated })
					)
				).toEqual(desktop);
			}
		}
	});

	test('native unvalidated writes require explicit true, including the deployed default', () => {
		for (const androidUntested of [undefined, false, 1 as unknown as boolean]) {
			const result = evaluateChecklist(
				input({ confirmations: { ...CONFIRMED, androidUntested } }),
				context({ androidWriteValidated: undefined })
			);
			expect(result.items.at(-1)).toEqual({
				id: 'android-untested',
				required: true,
				satisfied: false
			});
			expect(result.canWrite).toBe(false);
		}
		expect(
			evaluateChecklist(
				input({ confirmations: { ...CONFIRMED, androidUntested: true } }),
				context()
			).canWrite
		).toBe(true);
	});

	test('validated native writes omit the acknowledgement item', () => {
		const result = evaluateChecklist(input(), context({ androidWriteValidated: true }));
		expect(result.items.some(({ id }) => id === 'android-untested')).toBe(false);
		expect(result.items).toEqual(evaluateChecklist(input(), context({ cableMode: 'real' })).items);
		expect(result.canWrite).toBe(true);
	});

	test('experimental and YOLO confirmations remain independent, including the YOLO session', () => {
		for (const yolo of [false, true]) {
			const request = input({
				bands: yolo ? YOLO_BANDS : SHELF_BANDS,
				preampDb: -0.5,
				experimental: true,
				profile: yolo ? 'yolo' : 'standard',
				confirmations: { ...CONFIRMED, experimental: true, yoloWrite: true, androidUntested: true }
			});
			const ctx = context({ yoloSession: true });
			expect(evaluateChecklist(request, ctx).canWrite).toBe(true);
			for (const missing of yolo
				? (['experimental', 'yoloWrite', 'androidUntested'] as const)
				: (['experimental', 'androidUntested'] as const)) {
				expect(
					evaluateChecklist(
						{ ...request, confirmations: { ...request.confirmations, [missing]: false } },
						ctx
					).canWrite,
					missing
				).toBe(false);
			}
			if (yolo) {
				expect(evaluateChecklist(request, { ...ctx, yoloSession: false }).canWrite).toBe(false);
			}
		}
	});
});

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Real NativeHID and service authorization, with a fake plugin that only records I/O. */
async function nativeService(count = 1, interrupted = false) {
	const devices = Array.from({ length: count }, (_, index) => ({
		key: `cable-${index}`,
		vendorId: USB_VID,
		productId: USB_PID,
		productName: `Cable ${index + 1}`
	}));
	const open = vi.fn<OpenAuriUsbPlugin['open']>().mockResolvedValue({});
	const sendReport = vi.fn<OpenAuriUsbPlugin['sendReport']>().mockResolvedValue({});
	const plugin: OpenAuriUsbPlugin = {
		getInfo: async () => ({}),
		getDevices: async () => ({ devices }),
		requestDevice: async () => ({ devices }),
		open,
		close: async () => ({}),
		sendReport,
		diagnostics: async () => ({}),
		addListener: async () => ({ remove: async () => undefined })
	};
	const hid = new NativeHID(plugin);
	const clock = createFakeClock(0, { autoAdvance: true });
	const initial: JournalEntry[] = interrupted
		? [
				{
					schema: 1,
					at: T0 - 10_000,
					name: 'Padrão',
					crc: 0x1970,
					preampDb: padrao.preampDb,
					bands: padrao.eqBands,
					status: 'interrupted',
					device: 'Cable 1'
				}
			]
		: [];
	const journal = memoryJournal(initial);
	const flash = memoryFlash();
	const freshnessFetch = vi
		.fn<typeof fetch>()
		.mockImplementation(async () => new Response(JSON.stringify({ version: 'current' })));
	const service = createCableService({
		nativeFreshness: {
			version: 'current',
			fetch: freshnessFetch
		},
		hid,
		clock,
		journal,
		flash,
		now: () => T0 + clock.now(),
		lastWrittenLevelDb: () => null,
		sessionWriteCount: () => 0,
		userActivation: () => ({ isActive: true }),
		yoloSession: () => true,
		locks: null,
		inflight: null
	});
	cleanups.push(
		() => service.dispose(),
		() => hid.dispose()
	);
	await service.ready;
	await service.restore();
	const first = service.getState().devices[0];
	if (first === undefined) throw new Error('Missing native test cable');
	service.selectDevice(first);
	return { service, open, sendReport, flash, journal, freshnessFetch, clock };
}

describe('Native service enforces acknowledgement before any write I/O', () => {
	test.each(['single', 'rescue', 'queue', 'yolo'] as const)(
		'%s cannot bypass the item',
		async (path) => {
			const h = await nativeService(path === 'queue' ? 2 : 1, path === 'rescue');
			if (path === 'rescue') expect(h.service.getState().rescue).not.toBeNull();
			const request = input({
				...(path === 'rescue' ? NEUTRAL_CURVE : {}),
				...(path === 'yolo'
					? { bands: YOLO_BANDS, preampDb: -0.5, experimental: true, profile: 'yolo' as const }
					: {}),
				confirmations: { ...CONFIRMED, experimental: true, yoloWrite: true }
			});
			const write = (confirmed: boolean) => {
				const captured = {
					...request,
					confirmations: { ...request.confirmations, androidUntested: confirmed },
					gesture: h.service.createGesture(TRUSTED_CLICK),
					// These untrusted fields must never override the service-owned context.
					cableMode: 'real',
					androidWriteValidated: true
				};
				return path === 'queue'
					? h.service.writeQueue({ ...captured, devices: h.service.getState().devices })
					: h.service.write(captured);
			};
			expect(h.service.checklist(request).canWrite).toBe(false);
			expect(await write(false)).toMatchObject({
				status: 'refused',
				reason: 'checklist',
				checklist: {
					items: expect.arrayContaining([
						{ id: 'android-untested', required: true, satisfied: false }
					])
				}
			});
			expect(h.open).not.toHaveBeenCalled();
			expect(h.sendReport).not.toHaveBeenCalled();
			expect(h.flash.records).toEqual([]);
			const outcome = await write(true);
			expect(outcome.status).toBe(path === 'queue' ? 'done' : 'ok');
			expect(h.freshnessFetch).toHaveBeenCalledOnce();
			expect(h.sendReport).toHaveBeenCalled();
			expect(h.journal.entries.filter((entry) => entry.status === 'ok')).toHaveLength(
				path === 'queue' ? 2 : 1
			);
			if (path === 'queue' && outcome.status === 'done') {
				expect(outcome.items.map((item) => item.status)).toEqual(['ok', 'ok']);
			}
			if (path === 'rescue') expect(h.service.getState().rescue).toBeNull();
		}
	);

	test('the acknowledgement is captured once and reused by in-lock authorization', async () => {
		const h = await nativeService();
		let reads = 0;
		const result = await h.service.write({
			...input(),
			confirmations: {
				...CONFIRMED,
				get androidUntested() {
					reads += 1;
					return reads === 1;
				}
			},
			gesture: h.service.createGesture(TRUSTED_CLICK)
		});
		expect(result.status).toBe('ok');
		expect(reads).toBe(1);
	});
});

describe('Native service requires a fresh deployed policy on every write path', () => {
	test.each(['single', 'rescue', 'queue', 'yolo'] as const)(
		'%s refuses a newer deploy or offline cached build before any write I/O',
		async (path) => {
			for (const reason of ['newer', 'unavailable'] as const) {
				const h = await nativeService(path === 'queue' ? 2 : 1, path === 'rescue');
				if (reason === 'newer') {
					h.freshnessFetch.mockResolvedValue(new Response(JSON.stringify({ version: 'disabled' })));
				} else {
					h.freshnessFetch.mockRejectedValue(new TypeError('offline'));
				}
				const request = {
					...input({
						...(path === 'rescue' ? NEUTRAL_CURVE : {}),
						...(path === 'yolo'
							? { bands: YOLO_BANDS, preampDb: -0.5, experimental: true, profile: 'yolo' as const }
							: {}),
						confirmations: {
							...CONFIRMED,
							experimental: true,
							yoloWrite: true,
							androidUntested: true
						}
					}),
					gesture: h.service.createGesture(TRUSTED_CLICK)
				};
				const result =
					path === 'queue'
						? await h.service.writeQueue({ ...request, devices: h.service.getState().devices })
						: await h.service.write(request);
				expect(result).toMatchObject({
					status: 'refused',
					reason: 'error',
					error: expect.objectContaining({ reason })
				});
				if (result.status === 'refused') expect(result.error).toBeInstanceOf(NativeFreshnessError);
				expect(h.freshnessFetch).toHaveBeenCalledOnce();
				expect(h.open).not.toHaveBeenCalled();
				expect(h.sendReport).not.toHaveBeenCalled();
				expect(h.flash.records).toEqual([]);
				expect(h.journal.entries.filter((entry) => entry.status === 'ok')).toEqual([]);
				expect(h.service.getState().writing).toBe(false);
			}
		}
	);

	test('an already-open page cannot reuse an earlier successful policy check', async () => {
		const h = await nativeService();
		const write = () =>
			h.service.write({
				...input({ confirmations: { ...CONFIRMED, androidUntested: true } }),
				gesture: h.service.createGesture(TRUSTED_CLICK)
			});
		expect((await write()).status).toBe('ok');
		h.open.mockClear();
		h.sendReport.mockClear();
		await h.clock.sleep(2500);
		h.freshnessFetch.mockResolvedValue(new Response(JSON.stringify({ version: 'disabled' })));
		expect(await write()).toMatchObject({ status: 'refused', error: { reason: 'newer' } });
		expect(h.freshnessFetch).toHaveBeenCalledTimes(2);
		expect(h.open).not.toHaveBeenCalled();
		expect(h.sendReport).not.toHaveBeenCalled();
		expect(h.flash.records).toHaveLength(1);
	});
});
