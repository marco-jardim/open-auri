import { afterEach, describe, expect, test, vi } from 'vitest';
import { NEUTRO, PADRAO_AURI } from 'open-auri/catalog';
import { levelDb } from 'open-auri/safety';
import {
	CABLE_INFLIGHT_KEY,
	CABLE_WRITTEN_EVENT,
	NEUTRAL_CURVE,
	type CableWrittenDetail
} from '../../../src/lib/cable/index.ts';
import { WRITTEN_STORAGE_KEY } from '../../../src/lib/state/curve.svelte.ts';
import { m } from '../../../src/lib/paraglide/messages.js';
import { createClientApp, createAppContext, type ClientApp } from '../../../src/lib/app/index.ts';
import { get } from 'svelte/store';
import { createToastStore } from '../../../src/lib/components/chrome/toast.ts';
import {
	createYoloState,
	yolo as moduleYolo,
	YOLO_PHRASE
} from '../../../src/lib/state/yolo.svelte.ts';
import { MemoryStorage, fakeAppOptions } from './fakes.ts';

const apps: ClientApp[] = [];
afterEach(() => {
	for (const app of apps.splice(0)) app.dispose();
	vi.restoreAllMocks();
});
function setup() {
	const fake = fakeAppOptions();
	const app = createClientApp(fake.options);
	apps.push(app);
	return { ...fake, app };
}
const confirmations = { volumeLowered: true, keepConnected: true, experimental: false };
const click = { type: 'click', isTrusted: true } as const;

describe('browser app wiring with fake persistence and HID', () => {
	test('does not initialize browser state on the server', async () => {
		const context = createAppContext();
		expect(context.client).toBeNull();
		await expect(context.mount(fakeAppOptions().options)).resolves.toBeNull();
		expect(context.client).toBeNull();
		expect(context.status).toBe('idle');
		context.dispose();
	});

	test('an injected toast store is the app region (the layout owns it before the mount)', () => {
		const fake = fakeAppOptions();
		const toasts = createToastStore();
		const app = createClientApp({ ...fake.options, toasts });
		apps.push(app);
		expect(app.toasts).toBe(toasts);
		app.toasts.push('ok');
		expect(get(toasts)).toHaveLength(1);
		app.dispose();
		expect(get(toasts)).toHaveLength(0);
	});

	test('restores cable and audio once, without playing or writing', async () => {
		const { app, audio, hid, device } = setup();
		const restore = vi.spyOn(audio, 'restore');
		const devices = vi.spyOn(hid, 'getDevices');
		const write = vi.spyOn(app.cable, 'write');
		const first = app.start();
		expect(app.start()).toBe(first);
		await first;
		expect(restore).toHaveBeenCalledOnce();
		expect(devices).toHaveBeenCalledOnce();
		expect(audio.state().playing).toBe(false);
		expect(audio.state().ready).toBe(false);
		expect(write).not.toHaveBeenCalled();
		expect(device.attempts).toBe(0);
	});

	test('Neutro and Padrão Auri update only the editor; opening/cancelling never writes', async () => {
		const { app, device } = setup();
		await app.start();
		const write = vi.spyOn(app.cable, 'write');
		const gesture = vi.spyOn(app.cable, 'createGesture');
		expect(app.loadAuriDefault()).toBe(true);
		expect(app.state.curve.current.bands).toEqual(PADRAO_AURI.bands);
		expect(app.state.curve.current.preampDb).toBe(PADRAO_AURI.preampDb);
		expect(app.loadNeutral()).toBe(true);
		expect(app.state.curve.current.bands).toEqual(NEUTRO.bands);
		expect(app.state.curve.current.source).toBe(`preset:${NEUTRO.id}`);
		app.requestWrite();
		expect(app.pendingWrite?.bands).toEqual(NEUTRO.bands);
		app.loadAuriDefault();
		expect(app.pendingWrite?.bands).toEqual(NEUTRO.bands);
		app.closeChecklist();
		expect(app.pendingWrite).toBeNull();
		expect(write).not.toHaveBeenCalled();
		expect(gesture).not.toHaveBeenCalled();
		expect(device.attempts).toBe(0);
	});

	test('the curve store adopts undo steps under the injected Modo YOLO, not the module one', () => {
		const fake = fakeAppOptions();
		const yolo = createYoloState();
		const app = createClientApp({ ...fake.options, yolo });
		apps.push(app);
		const curve = app.state.curve;
		// Refused by the standard gate, accepted by the YOLO one: HP 30 Hz.
		const yoloOnly = {
			name: 'Subsônica',
			source: 'custom' as const,
			preampDb: -0.5,
			bands: [{ kind: 'HP' as const, freqHz: 30, qFactor: 0.71 }, ...NEUTRO.bands.slice(1)]
		};
		expect(curve.set(yoloOnly)).toBe(true);
		expect(app.loadAuriDefault()).toBe(true);
		expect(yolo.enable(YOLO_PHRASE, 'engenharia')).toBe(true);
		expect(moduleYolo.enabled).toBe(false);
		// This app's YOLO is on: the YOLO-only step comes back.
		expect(curve.undo()).toBe(true);
		expect(curve.current.bands).toEqual(yoloOnly.bands);
		expect(curve.redo()).toBe(true);
		expect(curve.current.bands).toEqual(PADRAO_AURI.bands);
		// Off again: it is skipped (and dropped), Neutro is next.
		yolo.disable();
		expect(curve.undo()).toBe(true);
		expect(curve.current.bands).toEqual(NEUTRO.bands);
	});

	describe('Modo YOLO free preview disables every normal write request', () => {
		function freePreviewApp() {
			const fake = fakeAppOptions();
			const yolo = createYoloState();
			const app = createClientApp({ ...fake.options, yolo });
			apps.push(app);
			expect(yolo.enable(YOLO_PHRASE, 'engenharia')).toBe(true);
			yolo.setFreePreview(true);
			expect(yolo.writeBlock()).toBe('free-preview');
			return { ...fake, app, yolo };
		}

		test('a top-bar request (no profile) opens no checklist and says why', () => {
			const { app, device } = freePreviewApp();
			const write = vi.spyOn(app.cable, 'write');
			app.requestWrite();
			expect(app.pendingWrite).toBeNull();
			expect(app.pendingProfile).toBe('standard');
			expect(get(app.toasts)).toMatchObject([
				{ message: m.yolo_reason_free_preview(), tone: 'error' }
			]);
			expect(write).not.toHaveBeenCalled();
			expect(device.attempts).toBe(0);
		});

		test('the YOLO profile, the standard one or a page curve: none opens a checklist', () => {
			const { app } = freePreviewApp();
			app.loadAuriDefault();
			// Curva/Cabo (YOLO profile), Biblioteca and the shared curve (an explicit curve).
			app.requestWrite(undefined, { profile: 'yolo' });
			expect(app.pendingWrite).toBeNull();
			app.requestWrite(undefined, { profile: 'standard' });
			expect(app.pendingWrite).toBeNull();
			app.requestWrite({ ...app.state.curve.current, name: 'Faixa' });
			expect(app.pendingWrite).toBeNull();
			expect(get(app.toasts)).toHaveLength(3);
		});

		test('the rescue still opens during the free preview', () => {
			const { app } = freePreviewApp();
			app.loadAuriDefault();
			app.requestRescue();
			expect(app.pendingWrite).toMatchObject(NEUTRAL_CURVE);
			expect(app.pendingProfile).toBe('standard');
			expect(app.state.curve.current.bands).toEqual(PADRAO_AURI.bands);
			expect(get(app.toasts)).toHaveLength(0);
		});

		test('turning the free preview off allows the request again', () => {
			const { app, yolo } = freePreviewApp();
			yolo.setFreePreview(false);
			app.requestWrite(undefined, { profile: 'yolo' });
			expect(app.pendingWrite).not.toBeNull();
			expect(app.pendingProfile).toBe('yolo');
		});
	});

	test('a real Modo YOLO write is marked and becomes the written snapshot', async () => {
		const fake = fakeAppOptions();
		const yolo = createYoloState();
		const app = createClientApp({ ...fake.options, yolo });
		apps.push(app);
		await app.start();
		await app.cable.connect();
		expect(yolo.enable(YOLO_PHRASE, 'engenharia')).toBe(true);
		// Complementary −6 dB shelves at −0.3 dB: only the YOLO gate accepts them (HS, g:preamp).
		const yoloOnly = {
			name: 'Prateleiras',
			source: 'custom' as const,
			preampDb: -0.3,
			bands: [
				{ kind: 'LS' as const, freqHz: 1000, gainDb: -6, qFactor: 0.7 },
				{ kind: 'HS' as const, freqHz: 1000, gainDb: -6, qFactor: 0.7 },
				...NEUTRAL_CURVE.bands.slice(2).map((band) => ({ ...band }))
			]
		};
		expect(app.state.curve.set(yoloOnly)).toBe(true);
		app.requestWrite(undefined, { profile: 'yolo' });
		expect(app.pendingProfile).toBe('yolo');
		const curve = app.pendingWrite;
		if (!curve) throw new Error('Missing checklist snapshot');
		const heard: CableWrittenDetail[] = [];
		app.cable.events.addEventListener(CABLE_WRITTEN_EVENT, (event) => {
			heard.push((event as CustomEvent<CableWrittenDetail>).detail);
		});
		const outcome = await app.cable.write({
			...curve,
			experimental: false,
			profile: 'yolo',
			confirmations: { ...confirmations, experimental: true, yoloWrite: true },
			gesture: app.cable.createGesture(click)
		});
		app.onWriteResult(outcome);
		expect(outcome.status).toBe('ok');
		expect(heard).toHaveLength(1);
		expect(heard[0]?.profile).toBe('yolo');
		expect(heard[0]?.waived).toEqual(expect.arrayContaining(['k:kind-not-allowed', 'g:preamp']));
		expect(heard[0]?.entry).toMatchObject({ status: 'ok', profile: 'yolo' });
		expect(app.state.curve.lastWritten?.bands).toEqual(yoloOnly.bands);
		expect(app.state.curve.lastWritten?.preampDb).toBe(yoloOnly.preampDb);
		expect(app.state.curve.dirty).toBe(false);
		expect(fake.local.getItem(WRITTEN_STORAGE_KEY)).toContain('"preampDb":-0.3');
	});

	test('rescue selects Neutro for the checklist, leaving the editor and cable alone', () => {
		const { app, device } = setup();
		app.loadAuriDefault();
		app.requestRescue();
		expect(app.pendingWrite).toMatchObject(NEUTRAL_CURVE);
		expect(app.state.curve.current.bands).toEqual(PADRAO_AURI.bands);
		expect(device.attempts).toBe(0);
	});

	test('service refuses missing confirmations/gesture; a confirmed write feeds state and level back', async () => {
		const { app, device, time, local, session } = setup();
		await app.start();
		await app.cable.connect();
		app.loadAuriDefault();
		app.requestWrite();
		const curve = app.pendingWrite;
		if (!curve) throw new Error('Missing checklist snapshot');
		const request = { ...curve, experimental: false, confirmations };
		expect((await app.cable.write({ ...request, gesture: null })).status).toBe('refused');
		expect(
			(
				await app.cable.write({
					...request,
					gesture: app.cable.createGesture(click),
					confirmations: { ...confirmations, volumeLowered: false }
				})
			).status
		).toBe('refused');
		expect(device.attempts).toBe(0);
		const outcome = await app.cable.write({ ...request, gesture: app.cable.createGesture(click) });
		app.onWriteResult(outcome);
		expect(outcome.status).toBe('ok');
		// 9 payload reports plus the commit report.
		expect(device.sent).toHaveLength(10);
		expect(app.state.curve.dirty).toBe(false);
		expect(app.state.journal.entries.at(-1)?.status).toBe('ok');
		expect(app.state.flash.state.total).toBe(1);
		expect(session.getItem('oa.flash.session')).toBe('1');
		expect(local.getItem('oa.journal')).toContain('"status":"ok"');
		time.value += 3000;
		const checklist = app.cable.checklist(request);
		expect(checklist.loudness.reasons).not.toContain('unknown-state');
		expect(checklist.counters.session).toBe(1);
	});

	test('the actual written snapshot stays distinct from edits made during I/O', async () => {
		const { app } = setup();
		await app.cable.connect();
		app.loadNeutral();
		app.requestWrite();
		const curve = app.pendingWrite;
		if (!curve) throw new Error('Missing checklist snapshot');
		const writing = app.cable.write({
			...curve,
			experimental: false,
			confirmations,
			gesture: app.cable.createGesture(click)
		});
		app.loadAuriDefault();
		await writing;
		expect(app.state.curve.lastWritten?.bands).toEqual(NEUTRO.bands);
		expect(app.state.curve.current.bands).toEqual(PADRAO_AURI.bands);
		expect(app.state.curve.dirty).toBe(true);
	});

	test('the last written level comes from the persisted journal: a reload keeps the jump warning', async () => {
		const fake = fakeAppOptions();
		const first = createClientApp(fake.options);
		apps.push(first);
		await first.start();
		await first.cable.connect();
		const quiet = { bands: NEUTRAL_CURVE.bands, preampDb: -4, experimental: false, confirmations };
		const outcome = await first.cable.write({
			...quiet,
			name: 'Quiet',
			gesture: first.cable.createGesture(click)
		});
		first.onWriteResult(outcome);
		expect(outcome.status).toBe('ok');
		expect(first.state.journal.lastOk?.preampDb).toBe(-4);
		const louder = { ...quiet, preampDb: -0.5 };
		fake.time.value += 3000;
		expect(first.cable.checklist(louder).loudness.reasons).toContain('jump');
		first.dispose();
		apps.splice(apps.indexOf(first), 1);

		// Same localStorage, fresh sessionStorage: a reload or a second tab.
		const reloaded = createClientApp({
			...fake.options,
			storage: { ...fake.options.storage, session: new MemoryStorage() }
		});
		apps.push(reloaded);
		await reloaded.start();
		const checklist = reloaded.cable.checklist(louder);
		expect(checklist.loudness.reasons).toContain('jump');
		expect(checklist.loudness.reasons).toContain('unknown-state');
		expect(checklist.loudness.deltaDb).toBeCloseTo(
			levelDb(NEUTRAL_CURVE.bands, -0.5) - levelDb(NEUTRAL_CURVE.bands, -4),
			6
		);
		// A simulated or interrupted entry after it does not replace the last real level.
		reloaded.state.journal.append({
			schema: 1,
			at: fake.time.value + 1,
			name: 'Rehearsal',
			crc: 0x4fff,
			preampDb: -0.5,
			bands: NEUTRAL_CURVE.bands.map((band) => ({ ...band })),
			status: 'simulated',
			device: 'USB DSP Audio (simulado)'
		});
		expect(reloaded.cable.checklist(louder).loudness.reasons).toContain('jump');
	});

	test('a marker left by a tab closed mid-write becomes an interrupted entry and rescue on start', async () => {
		const fake = fakeAppOptions();
		fake.local.setItem(
			CABLE_INFLIGHT_KEY,
			JSON.stringify({
				at: fake.time.value - 60_000,
				crc: 0x4fff,
				name: 'Neutro',
				preampDb: NEUTRAL_CURVE.preampDb,
				bands: NEUTRAL_CURVE.bands,
				device: 'USB DSP Audio',
				tabId: 'closed-tab'
			})
		);
		const app = createClientApp(fake.options);
		apps.push(app);
		await app.start();
		expect(app.state.journal.entries.at(-1)).toMatchObject({
			status: 'interrupted',
			at: fake.time.value - 60_000,
			device: 'USB DSP Audio'
		});
		expect(app.cableState.rescue).toEqual({
			at: fake.time.value - 60_000,
			deviceLabel: 'USB DSP Audio',
			reportsSent: null,
			fresh: true
		});
		expect(fake.local.getItem(CABLE_INFLIGHT_KEY)).toBeNull();
		expect(fake.device.attempts).toBe(0);
	});

	test('simulated writes never clean the editor or increment real flash counters', async () => {
		const fake = fakeAppOptions();
		const app = createClientApp({
			...fake.options,
			cable: { ...fake.options.cable, hid: null }
		});
		apps.push(app);
		await app.cable.connect();
		app.requestWrite();
		const curve = app.pendingWrite;
		if (!curve) throw new Error('Missing checklist snapshot');
		const outcome = await app.cable.write({
			...curve,
			experimental: false,
			confirmations,
			gesture: app.cable.createGesture(click)
		});
		app.onWriteResult(outcome);
		expect(outcome.status).toBe('simulated');
		expect(app.state.curve.dirty).toBe(true);
		expect(app.state.curve.lastWritten).toBeNull();
		expect(app.state.flash.state.total).toBe(0);
		expect(app.state.flash.state.session).toBe(0);
		expect(app.state.journal.entries.at(-1)?.status).toBe('simulated');
		expect(fake.device.attempts).toBe(0);
	});
});
