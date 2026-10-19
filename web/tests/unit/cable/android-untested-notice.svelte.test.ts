import axe from 'axe-core';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import AndroidUntestedNotice from '#lib/components/cable/AndroidUntestedNotice.svelte';
import type { NativeCableStatus } from '#lib/cable/native-state.svelte.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import { ANDROID_REPORT_URL } from '#lib/cable/android-links.ts';

beforeEach(async () => {
	localStorage.removeItem('oa.androidDisclaimerAck');
	await setLocale('pt-BR', { reload: false });
});
afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
	localStorage.removeItem('oa.androidDisclaimerAck');
});

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
		await userEvent.keyboard('{Escape}');
		await expect.element(dialog).toBeVisible();
		expect(localStorage.getItem('oa.androidDisclaimerAck')).toBeNull();
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
