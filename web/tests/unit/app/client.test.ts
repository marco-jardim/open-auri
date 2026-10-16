import { afterEach, describe, expect, test, vi } from 'vitest';
import { NEUTRO, PADRAO_AURI } from 'open-auri/catalog';
import { NEUTRAL_CURVE } from '../../../src/lib/cable/index.ts';
import { createClientApp, createAppContext, type ClientApp } from '../../../src/lib/app/index.ts';
import { fakeAppOptions } from './fakes.ts';

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
	test('does not initialize browser state on the server', () => {
		const context = createAppContext();
		expect(context.client).toBeNull();
		expect(context.mount(fakeAppOptions().options)).toBeNull();
		expect(context.client).toBeNull();
		context.dispose();
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
