import axe from 'axe-core';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import AndroidUntestedNotice from '#lib/components/cable/AndroidUntestedNotice.svelte';
import type { NativeCableStatus } from '#lib/cable/native-state.svelte.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import { ANDROID_REPORT_URL } from '#lib/cable/android-links.ts';
import '../primitives/design-system.ts';

beforeEach(async () => {
	localStorage.removeItem('oa.androidDisclaimerAck');
	await setLocale('pt-BR', { reload: false });
});
afterEach(async () => {
	await cleanup();
	// The locale persists (cookie/localStorage) into later test files of the same browser.
	await setLocale('pt-BR', { reload: false });
	vi.restoreAllMocks();
	localStorage.removeItem('oa.androidDisclaimerAck');
	await page.viewport(1440, 900);
});

test.each([320, 360, 1080])(
	'the notice is horizontally centered and contained at %i CSS pixels',
	async (width) => {
		await page.viewport(width, 760);
		await render(AndroidUntestedNotice, { kind: 'native', validated: false });
		const dialog = page.getByRole('dialog');
		await expect.element(dialog).toBeVisible();
		const node = dialog.element();
		const rect = node.getBoundingClientRect();
		const viewport = document.documentElement.clientWidth;
		expect(getComputedStyle(node).boxSizing).toBe('border-box');
		expect(rect.left).toBeGreaterThanOrEqual(15);
		expect(viewport - rect.right).toBeGreaterThanOrEqual(15);
		expect(Math.abs(rect.left - (viewport - rect.right))).toBeLessThanOrEqual(1);
		expect(node.scrollWidth).toBeLessThanOrEqual(node.clientWidth);
	}
);

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`first-use modal is labelled, described, focus-trapped and only acknowledgement closes it: ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		const screen = await render(AndroidUntestedNotice, {
			kind: 'native',
			validated: false,
			version: 1
		});
		const dialog = page.getByRole('dialog');
		const ack = dialog.getByRole('button', { name: m.android_untested_ack() });
		await expect.element(dialog).toBeVisible();
		await expect.element(dialog).toHaveAttribute('aria-modal', 'true');
		await expect.element(dialog).toHaveAccessibleName(m.android_untested_title());
		await expect.element(dialog).toHaveAccessibleDescription(m.android_untested_body());
		await expect.element(ack).toHaveFocus();
		expect(dialog.getByRole('button').elements()).toHaveLength(1);
		for (let press = 0; press < 3; press += 1) {
			await userEvent.keyboard('{Escape}');
			await expect.element(dialog).toBeVisible();
			expect(localStorage.getItem('oa.androidDisclaimerAck')).toBeNull();
		}
		await userEvent.keyboard('{Tab}');
		await expect
			.element(dialog.getByRole('link', { name: m.android_report_result() }))
			.toHaveFocus();
		await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
		await expect.element(ack).toHaveFocus();
		const { violations } = await axe.run(screen.container);
		expect(
			violations.filter(({ impact }) => impact === 'serious' || impact === 'critical')
		).toEqual([]);
		await ack.click();
		expect(page.getByRole('dialog').elements()).toHaveLength(0);
		expect(localStorage.getItem('oa.androidDisclaimerAck')).toBe('1');
		await cleanup();
		await render(AndroidUntestedNotice, { kind: 'native', validated: false, version: 1 });
		expect(page.getByRole('dialog').elements()).toHaveLength(0);
	});
}

test('a higher disclaimer version reopens the modal', async () => {
	localStorage.setItem('oa.androidDisclaimerAck', '1');
	const screen = await render(AndroidUntestedNotice, {
		kind: 'native',
		validated: false,
		version: 1
	});
	expect(page.getByRole('dialog').elements()).toHaveLength(0);
	await screen.rerender({ version: 2 });
	await expect.element(page.getByRole('dialog')).toBeVisible();
	await page.getByRole('button', { name: m.android_untested_ack() }).click();
	expect(localStorage.getItem('oa.androidDisclaimerAck')).toBe('2');
});

test('recovery docs use a banner without acknowledging; the next non-docs page still requires acknowledgement', async () => {
	const screen = await render(AndroidUntestedNotice, {
		kind: 'native',
		validated: false,
		version: 1
	});
	await expect.element(page.getByRole('dialog')).toBeVisible();
	await expect
		.element(page.getByRole('link', { name: m.android_how_to_recover() }))
		.toHaveAttribute('href', '/docs#android-resgate');
	// The root layout switches presentation when navigation reaches /docs.
	await screen.rerender({ presentation: 'banner' });
	expect(page.getByRole('dialog').elements()).toHaveLength(0);
	await expect.element(page.getByRole('complementary')).toBeVisible();
	expect(document.querySelector('dialog[open]')).toBeNull();
	expect(localStorage.getItem('oa.androidDisclaimerAck')).toBeNull();
	await screen.rerender({ presentation: 'modal' });
	await expect.element(page.getByRole('dialog')).toBeVisible();
	await page.getByRole('button', { name: m.android_untested_ack() }).click();
	expect(localStorage.getItem('oa.androidDisclaimerAck')).toBe('1');
});

const kinds: NativeCableStatus['kind'][] = [
	'native',
	'native-outdated',
	'native-write-disabled',
	'native-no-usb-host'
];
test.each(kinds)('all app states show the notice and a persistent banner: %s', async (kind) => {
	await render(AndroidUntestedNotice, { kind, validated: false });
	await expect.element(page.getByRole('dialog')).toBeVisible();
	await page.getByRole('button', { name: m.android_untested_ack() }).click();
	await cleanup();
	await render(AndroidUntestedNotice, { kind, presentation: 'banner', validated: false });
	await expect.element(page.getByRole('complementary')).toBeVisible();
	await expect.element(page.getByText(m.android_untested_short())).toBeVisible();
	await expect
		.element(page.getByRole('link', { name: m.android_report_result() }))
		.toHaveAttribute('href', ANDROID_REPORT_URL);
	await expect
		.element(page.getByRole('link', { name: m.android_how_to_recover() }))
		.toHaveAttribute('href', '/docs#android-resgate');
	expect(page.getByRole('dialog').elements()).toHaveLength(0);
});

for (const presentation of ['modal', 'banner'] as const) {
	test.each([
		{ kind: 'none', validated: false },
		{ kind: 'native', validated: true }
	] as const)(
		`${presentation} is absent outside the app or after validation: $kind, $validated`,
		async (props) => {
			const screen = await render(AndroidUntestedNotice, { ...props, presentation });
			expect(screen.container.querySelector('dialog, aside')).toBeNull();
		}
	);
}

test('storage read errors show the modal; write errors allow a choice without crashing and reopen next visit', async () => {
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
		throw new Error('blocked');
	});
	vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
		throw new Error('blocked');
	});
	await render(AndroidUntestedNotice, { kind: 'native', validated: false });
	await expect.element(page.getByRole('dialog')).toBeVisible();
	await page.getByRole('button', { name: m.android_untested_ack() }).click();
	expect(page.getByRole('dialog').elements()).toHaveLength(0);
	await cleanup();
	await render(AndroidUntestedNotice, { kind: 'native', validated: false });
	await expect.element(page.getByRole('dialog')).toBeVisible();
});
