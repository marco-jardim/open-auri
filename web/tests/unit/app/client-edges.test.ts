import { afterEach, expect, test, vi } from 'vitest';
import { NEUTRO } from 'open-auri/catalog';
import { createClientApp, type ClientApp } from '#lib/app/index.ts';
import { disposeAudioEngine, getAudioEngine } from '#lib/audio/engine.ts';
import { fakeAppOptions } from './fakes.ts';

const apps: ClientApp[] = [];
const confirmations = { volumeLowered: true, keepConnected: true, experimental: false };
const click = { type: 'click', isTrusted: true } as const;

afterEach(async () => {
	for (const app of apps.splice(0)) app.dispose();
	await disposeAudioEngine();
});

function setup() {
	const fake = fakeAppOptions();
	const app = createClientApp(fake.options);
	apps.push(app);
	return { app, ...fake };
}

test('pending checklist cannot be replaced by a second request or rescue and detects experimental kinds', () => {
	const { app } = setup();
	expect(app.experimentalWrite).toBe(false);
	app.state.curve.update({
		bands: [{ kind: 'HS', freqHz: 8000, gainDb: -3, qFactor: 0.7 }, ...NEUTRO.bands.slice(1)]
	});
	app.requestWrite();
	const pending = app.pendingWrite;
	expect(app.experimentalWrite).toBe(true);
	app.loadNeutral();
	app.requestWrite();
	app.requestRescue();
	expect(app.pendingWrite).toBe(pending);
	app.closeChecklist();
	expect(app.experimentalWrite).toBe(false);
	app.requestRescue();
	expect(app.pendingWrite?.bands).toEqual(NEUTRO.bands);
});

test('active I/O prevents opening/replacing/closing checklists and a write without a pending snapshot uses the sent curve', async () => {
	const { app, device, time, audio } = setup();
	await app.cable.connect();
	const current = app.state.curve.current;
	const writing = app.cable.write({
		...current,
		experimental: false,
		confirmations,
		gesture: app.cable.createGesture(click)
	});
	app.requestWrite();
	app.requestRescue();
	app.closeChecklist();
	expect(app.pendingWrite).toBeNull();
	await writing;
	expect(app.state.curve.lastWritten?.bands).toEqual(current.bands);
	expect(device.sent).toHaveLength(10);
	time.value += 3000;
	app.requestWrite();
	const pending = app.pendingWrite;
	const next = app.cable.write({
		...current,
		experimental: false,
		confirmations,
		gesture: app.cable.createGesture(click)
	});
	app.closeChecklist();
	app.requestRescue();
	expect(app.pendingWrite).toBe(pending);
	await next;
	// The close asked for mid-write is applied when the write ends: nothing stays wedged.
	expect(app.pendingWrite).toBeNull();
	time.value += 3000;
	app.requestRescue();
	expect(app.pendingWrite?.bands).toEqual(NEUTRO.bands);
	app.closeChecklist();
	expect(app.pendingWrite).toBeNull();
	const stop = vi.spyOn(audio, 'stop');
	app.dispose();
	app.dispose();
	expect(stop).toHaveBeenCalledOnce();
});

test('a write without a close request keeps the checklist open for its outcome', async () => {
	const { app } = setup();
	await app.cable.connect();
	app.requestWrite();
	const pending = app.pendingWrite;
	expect(
		(
			await app.cable.write({
				...app.state.curve.current,
				experimental: false,
				confirmations,
				gesture: app.cable.createGesture(click)
			})
		).status
	).toBe('ok');
	expect(app.pendingWrite).toBe(pending);
});

test('the default audio singleton is restored only on creation, not a second time by start', async () => {
	const fake = fakeAppOptions();
	const app = createClientApp({ ...fake.options, audio: undefined, now: undefined });
	apps.push(app);
	expect(app.audio).toBe(getAudioEngine());
	const started = app.start();
	expect(app.start()).toBe(started);
	await started;
	expect(app.audio.state()).toMatchObject({ playing: false, ready: false });
	expect(fake.device.attempts).toBe(0);
});
