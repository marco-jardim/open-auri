import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import CompararPage from '#lib/components/pages/comparar/CompararPage.svelte';
import { copy } from '#lib/components/pages/comparar/copy.ts';
import { downloadComparison } from '#lib/components/pages/comparar/export.ts';
import { createClientApp, type ClientApp } from '#lib/app/client.svelte.ts';
import { createAudioEngine } from '#lib/audio/engine.ts';
import { setLocale } from '#lib/paraglide/runtime.js';

vi.mock('#lib/components/pages/comparar/export.ts', async (original) => ({
	...(await original<typeof import('#lib/components/pages/comparar/export.ts')>()),
	downloadComparison: vi.fn()
}));

let app: ClientApp | null = null;
const t = copy('en-US');

afterEach(async () => {
	await cleanup();
	app?.dispose();
	await app?.audio.dispose();
	app = null;
	vi.restoreAllMocks();
	vi.mocked(downloadComparison).mockReset();
	await setLocale('pt-BR', { reload: false });
});

test('A/B selectors, swap and same-lane comparisons update selection, cabling and export options', async () => {
	await setLocale('en-US', { reload: false });
	const screen = await render(CompararPage, { locale: 'en-US' });
	const difference = page.getByRole('region', { name: t.where, exact: true });
	await difference.getByRole('combobox', { name: t.before, exact: true }).selectOptions('3');
	await difference.getByRole('combobox', { name: t.after, exact: true }).selectOptions('4');
	await difference.getByRole('button', { name: /^A ·/ }).click();
	expect(screen.container.querySelectorAll('.lane-head')[2]?.getAttribute('aria-pressed')).toBe(
		'true'
	);
	await difference.getByRole('button', { name: /^B ·/ }).click();
	expect(screen.container.querySelectorAll('.lane-head')[3]?.getAttribute('aria-pressed')).toBe(
		'true'
	);
	await difference.getByRole('button', { name: `${t.swap} ⇅`, exact: true }).click();
	await expect
		.element(difference.getByRole('combobox', { name: t.before, exact: true }))
		.toHaveValue('4');
	await expect
		.element(difference.getByRole('combobox', { name: t.after, exact: true }))
		.toHaveValue('3');
	await difference.getByRole('combobox', { name: t.after, exact: true }).selectOptions('4');
	expect(screen.container.querySelector('.bay-cables .cable')).toBeNull();
	await expect.element(difference.getByText(t.noRegions, { exact: true })).toBeVisible();
	await page.getByRole('checkbox', { name: t.match, exact: true }).click();
	const threshold = difference.getByRole('slider').element();
	if (!(threshold instanceof HTMLInputElement)) throw new Error('Missing threshold');
	threshold.value = '12';
	threshold.dispatchEvent(new Event('input', { bubbles: true }));
	await tick();
	await page.getByRole('checkbox', { name: t.exportDelta, exact: true }).click();
	vi.mocked(downloadComparison).mockResolvedValue(undefined);
	await page.getByRole('button', { name: t.exportSvg, exact: true }).click();
	await page.getByRole('button', { name: t.exportPng, exact: true }).click();
	expect(vi.mocked(downloadComparison).mock.calls.map(([, format]) => format)).toEqual([
		'svg',
		'png'
	]);
	const svg = vi.mocked(downloadComparison).mock.calls[0]?.[0];
	expect(svg).toContain('<svg');
	expect(svg).not.toContain('Δ = B − A');
});

test('export failure is announced and disarming to a single lane then none clears the patch bay and preview', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
	vi.mocked(downloadComparison).mockRejectedValueOnce(new Error('download denied'));
	const screen = await render(CompararPage, { locale: 'en-US' });
	const play = page.getByRole('button', { name: t.play, exact: true });
	await expect.element(play).toHaveAttribute('aria-disabled', 'true');
	await expect.element(play).toHaveAccessibleDescription(t.reasonEngine);
	await page.getByRole('button', { name: t.exportPng, exact: true }).click();
	await expect.element(page.getByRole('alert')).toHaveTextContent(t.failed);
	for (const id of [1, 2, 3])
		await page.getByRole('switch', { name: `ARM · ${t.track} ${id}`, exact: true }).click();
	expect(screen.container.querySelector('.bay-cables')).toBeNull();
	const difference = page.getByRole('region', { name: t.where, exact: true });
	await expect
		.element(difference.getByRole('combobox', { name: t.before, exact: true }))
		.toHaveValue('4');
	await expect
		.element(difference.getByRole('combobox', { name: t.after, exact: true }))
		.toHaveValue('4');
	await page.getByRole('switch', { name: `ARM · ${t.track} 4`, exact: true }).click();
	for (const name of [t.exportSvg, t.exportPng]) {
		await expect
			.element(page.getByRole('button', { name, exact: true }))
			.toHaveAttribute('aria-disabled', 'true');
		await expect
			.element(page.getByRole('button', { name, exact: true }))
			.toHaveAccessibleDescription(t.empty);
	}
	await expect.element(page.getByRole('img', { name: t.exportPreview })).not.toBeInTheDocument();
});

test('a real app exposes its flash counter and a selected lane follows solo and mute visibility', async () => {
	app = createClientApp({
		storage: { local: null, session: null, indexedDB: null, channel: null },
		audio: createAudioEngine({ indexedDB: null })
	});
	await app.state.ready;
	const screen = await render(CompararPage, { app, locale: 'en-US' });
	expect(screen.container.querySelector('.drums')?.textContent).toBe('0000');
	await page.getByRole('button', { name: `${t.track} 3`, exact: true }).click();
	expect(screen.container.querySelectorAll('.lane-head')[2]?.getAttribute('aria-pressed')).toBe(
		'true'
	);
	await page.getByRole('switch', { name: `SOLO · ${t.track} 2`, exact: true }).click();
	expect(screen.container.querySelectorAll('.lane-head')[1]?.getAttribute('aria-pressed')).toBe(
		'true'
	);
	await page.getByRole('switch', { name: `MUTE · ${t.track} 2`, exact: true }).click();
	expect(screen.container.querySelectorAll('.lane-head')[0]?.getAttribute('aria-pressed')).toBe(
		'true'
	);
});
