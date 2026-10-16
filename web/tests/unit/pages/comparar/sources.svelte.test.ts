import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import CompararPage from '#lib/components/pages/comparar/CompararPage.svelte';
import TrackLane from '#lib/components/pages/comparar/TrackLane.svelte';
import { copy } from '#lib/components/pages/comparar/copy.ts';
import { initialTracks } from '#lib/components/pages/comparar/comparison.ts';
import { createClientApp, type ClientApp } from '#lib/app/client.svelte.ts';
import { createAudioEngine } from '#lib/audio/engine.ts';
import { setLocale } from '#lib/paraglide/runtime.js';

const { commit, dispose } = vi.hoisted(() => ({ commit: vi.fn(), dispose: vi.fn() }));
vi.mock('#lib/workers/gate-client.ts', () => ({
	createGateWorker: () => ({ commit, dispose, cancel: vi.fn() })
}));

let app: ClientApp | null = null;
afterEach(async () => {
	await cleanup();
	app?.dispose();
	await app?.audio.dispose();
	app = null;
	commit.mockReset();
	dispose.mockReset();
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
});

async function source(value: string) {
	const input = document.getElementById('comparar-source-1');
	if (!(input instanceof HTMLSelectElement)) throw new Error('Missing track source');
	if (![...input.options].some((option) => option.value === value)) {
		throw new Error(`Unknown track source ${value}`);
	}
	input.value = value;
	input.dispatchEvent(new Event('change', { bubbles: true }));
	await tick();
}

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`unavailable, refused and failed sources preserve the previous track in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const t = copy(locale);
		await render(CompararPage, { app: null, locale });
		await source('current');
		await expect.element(page.getByRole('alert')).toHaveTextContent(t.failed);
		commit.mockResolvedValueOnce({ verdict: { ok: false, reasons: [{ code: 'g:preamp' }] } });
		await source('preset:padrao');
		await expect.element(page.getByRole('alert')).toHaveTextContent(`${t.invalidCurve} g:preamp`);
		expect((document.getElementById('comparar-source-1') as HTMLSelectElement).value).toBe(
			'preset:neutro'
		);
		commit.mockRejectedValueOnce(new Error('worker failed'));
		await source('preset:padrao');
		await expect.element(page.getByRole('alert')).toHaveTextContent(t.failed);
		commit.mockResolvedValueOnce({ verdict: { ok: true, reasons: [] } });
		await source('preset:padrao');
		await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
		expect((document.getElementById('comparar-source-1') as HTMLSelectElement).value).toBe(
			'preset:padrao'
		);
		await cleanup();
		expect(dispose).toHaveBeenCalledOnce();
	});
}

test('a late source response cannot replace a more recent track selection', async () => {
	let finish: ((value: unknown) => void) | undefined;
	commit.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
	await render(CompararPage, { app: null, locale: 'en-US' });
	await source('preset:padrao');
	commit.mockResolvedValueOnce({ verdict: { ok: true, reasons: [] } });
	await source('preset:pref6');
	await expect
		.poll(() => (document.getElementById('comparar-source-1') as HTMLSelectElement).value)
		.toBe('preset:pref6');
	finish?.({ verdict: { ok: true, reasons: [] } });
	await tick();
	expect((document.getElementById('comparar-source-1') as HTMLSelectElement).value).toBe(
		'preset:pref6'
	);
});

test('editor and library are snapshots; failed playback reports an error and stops', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
	app = createClientApp({
		storage: { local: null, session: null, indexedDB: null, channel: null },
		audio: createAudioEngine({ indexedDB: null })
	});
	await app.state.ready;
	const saved = await app.state.library.save({
		...app.state.curve.current,
		name: 'Local snapshot'
	});
	if (!saved) throw new Error('Could not prepare local curve');
	commit.mockResolvedValue({ verdict: { ok: true, reasons: [] } });
	const t = copy('en-US');
	const screen = await render(CompararPage, { app, locale: 'en-US' });
	await source(`library:${saved.id}`);
	await expect
		.poll(() => screen.container.querySelector('.lane .tape-label p')?.textContent)
		.toBe(t.snapshot);
	await source('current');
	expect(commit).toHaveBeenCalledTimes(2);
	vi.spyOn(app.audio, 'start').mockRejectedValue(new Error('audio denied'));
	const stop = vi.spyOn(app.audio, 'stop');
	await page.getByRole('button', { name: t.play, exact: true }).click();
	await expect.element(page.getByRole('alert')).toHaveTextContent(t.audioFailed);
	expect(stop).toHaveBeenCalled();
});

test('custom experimental lane delegates source/toggles and never selects a disarmed track', async () => {
	const track = initialTracks()[0];
	const t = copy('en-US');
	const onSource = vi.fn();
	const onToggle = vi.fn();
	const onSelect = vi.fn();
	const screen = await render(TrackLane, {
		track: {
			...track,
			armed: false,
			curve: {
				...track.curve,
				name: 'Snapshot',
				source: 'custom',
				bands: [{ kind: 'HP', freqHz: 100, qFactor: 0.7 }, ...track.curve.bands.slice(1)]
			}
		},
		t,
		locale: 'en-US',
		selected: false,
		playing: false,
		library: [{ id: 'saved', name: 'Library choice' }],
		onSource,
		onToggle,
		onSelect
	});
	await expect.element(page.getByRole('button', { name: `${t.track} 1` })).toBeDisabled();
	await expect.element(page.getByText(t.experimental, { exact: true })).toBeVisible();
	await page.getByRole('combobox').selectOptions('library:saved');
	expect(onSource).toHaveBeenCalledWith('library:saved');
	expect((screen.container.querySelector('select') as HTMLSelectElement).value).toBe('custom');
	for (const toggle of ['ARM', 'SOLO', 'MUTE'])
		await page.getByRole('switch', { name: `${toggle} · ${t.track} 1` }).click();
	expect(onToggle.mock.calls.map(([value]) => value)).toEqual(['armed', 'solo', 'mute']);
	expect(onSelect).not.toHaveBeenCalled();
	await screen.rerender({
		track: { ...track, curve: { ...track.curve, source: 'preset:padrao' } }
	});
	await page.getByRole('button', { name: `${t.track} 1` }).click();
	expect(onSelect).toHaveBeenCalledOnce();
	await expect.element(page.getByText(t.descriptionOriginal, { exact: true })).toBeVisible();
});
