import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import VuReferenceSelect from '#lib/components/meters/VuReferenceSelect.svelte';
import { setReference } from '#lib/audio/meters.ts';
import { METER_REFERENCE_KEY, createMeterRefStore } from '#lib/state/meterRef.svelte.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';

vi.mock(import('#lib/audio/meters.ts'), async (original) => ({
	...(await original()),
	setReference: vi.fn()
}));

const option = (value: string) =>
	page.getByRole('radio', { name: m.meters_vu_reference_option({ value }) });

let stores: { dispose(): void }[] = [];

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
	localStorage.removeItem(METER_REFERENCE_KEY);
	vi.mocked(setReference).mockClear();
	stores = [];
});

afterEach(async () => {
	await cleanup();
	for (const store of stores) store.dispose();
	localStorage.removeItem(METER_REFERENCE_KEY);
});

test('a labelled radio group applies the stored reference on mount', async () => {
	localStorage.setItem(METER_REFERENCE_KEY, '-14');
	const store = createMeterRefStore();
	stores.push(store);
	await render(VuReferenceSelect, { store });
	const group = page.getByRole('group', { name: m.meters_vu_reference() });
	await expect.element(group).toBeVisible();
	await expect.element(group).toHaveAccessibleDescription(m.meters_vu_reference_hint());
	await expect.element(option('−14')).toBeChecked();
	await expect.element(option('−18')).not.toBeChecked();
	expect(page.getByRole('radio').elements()).toHaveLength(3);
	expect(setReference).toHaveBeenCalledWith(-14);
});

test('clicking sets the store (persisted) and calls setReference for every tap', async () => {
	const store = createMeterRefStore();
	stores.push(store);
	await render(VuReferenceSelect, { store });
	expect(setReference).toHaveBeenLastCalledWith(-18);
	await option('−20').click();
	expect(store.value).toBe(-20);
	expect(localStorage.getItem(METER_REFERENCE_KEY)).toBe('-20');
	expect(setReference).toHaveBeenLastCalledWith(-20);
	await expect.element(option('−20')).toBeChecked();
});

test('is keyboard operable: arrows move the choice and apply it', async () => {
	const store = createMeterRefStore();
	stores.push(store);
	await render(VuReferenceSelect, { store });
	(option('−18').element() as HTMLInputElement).focus();
	await userEvent.keyboard('{ArrowRight}');
	await expect.element(option('−20')).toBeChecked();
	expect(store.value).toBe(-20);
	await userEvent.keyboard('{ArrowRight}');
	await expect.element(option('−14')).toBeChecked();
	expect(store.value).toBe(-14);
	expect(setReference).toHaveBeenLastCalledWith(-14);
});

test('a change from elsewhere (another tab) is applied to the taps too', async () => {
	const store = createMeterRefStore();
	stores.push(store);
	await render(VuReferenceSelect, { store });
	vi.mocked(setReference).mockClear();
	store.set(-14);
	flushSync();
	expect(setReference).toHaveBeenCalledWith(-14);
	await expect.element(option('−14')).toBeChecked();
});
