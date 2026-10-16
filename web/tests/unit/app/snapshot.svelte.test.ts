import { afterEach, expect, test } from 'vitest';
import { createClientApp, type ClientApp } from '#lib/app/index.ts';
import type { CurrentCurve } from '#lib/state/model.ts';
import { fakeAppOptions } from './fakes.ts';

const apps: ClientApp[] = [];

afterEach(async () => {
	for (const app of apps.splice(0)) {
		app.dispose();
		await app.audio.dispose();
	}
});

test('requestWrite copies a deep $state curve (R2-02: no DataCloneError)', () => {
	const app = createClientApp(fakeAppOptions().options);
	apps.push(app);
	const current = app.state.curve.current;
	// Like Biblioteca's selected tape: a deep $state proxy with nested arrays and objects.
	const proxied = $state<CurrentCurve>({
		...current,
		name: 'Proxied',
		bands: current.bands.map((band) => ({ ...band }))
	});
	expect(() => structuredClone(proxied)).toThrow();
	app.requestWrite(proxied);
	expect(app.pendingWrite).toMatchObject({ schema: 1, name: 'Proxied' });
	expect(app.pendingWrite?.bands).toEqual(current.bands);
	expect(app.pendingWrite?.bands).not.toBe(proxied.bands);
	expect(() => structuredClone(app.pendingWrite)).not.toThrow();
});
