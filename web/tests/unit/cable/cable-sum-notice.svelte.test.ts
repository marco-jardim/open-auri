import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { createClientApp, type ClientApp } from '#lib/app/index.ts';
import type { CableState } from '#lib/cable/types.ts';
import CableSumNotice from '#lib/components/cable/CableSumNotice.svelte';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import { fakeAppOptions } from '../app/fakes.ts';

let apps: ClientApp[] = [];
beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
});
afterEach(async () => {
	await cleanup();
	for (const app of apps) app.dispose();
	apps = [];
	vi.restoreAllMocks();
});

function client(state: Partial<CableState> = {}) {
	const app = createClientApp(fakeAppOptions().options);
	apps.push(app);
	vi.spyOn(app, 'cableState', 'get').mockReturnValue({ ...app.cableState, ...state });
	return app;
}

test('orphan takes priority over blind and flat and offers the dismiss action', async () => {
	const app = client({
		connection: 'connected',
		liveOrphan: { crc: 1, at: 0, deviceLabel: 'Cabo' }
	});
	const dismiss = vi.spyOn(app.cable, 'dismissLiveOrphan');
	await render(CableSumNotice, { app, flat: true, comparing: false, variant: 'blind' });
	expect(document.querySelector('[role="note"]')?.textContent).toContain(m.cable_live_orphan());
	expect(page.getByRole('note').elements()).toHaveLength(1);
	expect(page.getByText(m.cable_sum_blind()).elements()).toHaveLength(0);
	await page.getByRole('button', { name: m.cable_live_orphan_dismiss() }).click();
	expect(dismiss).toHaveBeenCalledOnce();
});

test('connected blind takes priority over the flat notice', async () => {
	await render(CableSumNotice, {
		app: client({ connection: 'connected' }),
		flat: true,
		comparing: false,
		variant: 'blind'
	});
	await expect.element(page.getByRole('note')).toHaveTextContent(m.cable_sum_blind());
});

test('flat without a comparison explains identical browser A and B', async () => {
	await render(CableSumNotice, {
		app: client({ connection: 'connected' }),
		flat: true,
		comparing: false
	});
	await expect.element(page.getByRole('note')).toHaveTextContent(m.cable_sum_flat());
});

test.each([true, false])(
	'connected EQ preview offers the right hint for liveCapable=%s',
	async (liveCapable) => {
		await render(CableSumNotice, {
			app: client({ connection: 'connected', liveCapable }),
			flat: false,
			comparing: false
		});
		const note = document.querySelector('[role="note"]');
		expect(note?.textContent).toContain(m.cable_sum_note());
		expect(note?.textContent).toContain(
			liveCapable ? m.cable_sum_hint() : m.cable_sum_hint_output()
		);
	}
);

test('flat during a comparison leaves the comparison control to explain it', async () => {
	await render(CableSumNotice, {
		app: client({ connection: 'connected' }),
		flat: true,
		comparing: true
	});
	expect(page.getByRole('note').elements()).toHaveLength(0);
});

test('no app, missing cableState, and disconnected without flat render nothing', async () => {
	for (const app of [null, {} as ClientApp, client()]) {
		await render(CableSumNotice, { app, flat: false, comparing: false });
		expect(page.getByRole('note').elements()).toHaveLength(0);
		await cleanup();
	}
});
