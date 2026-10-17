import axe from 'axe-core';
import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { setLocale } from '#lib/paraglide/runtime.js';
import { IDLE_STATE } from '#lib/audio/engine.ts';
import { neutralCurve } from '#lib/state/model.ts';
import { archiveTapes, type Tape } from '#lib/components/pages/biblioteca/archive.ts';
import Biblioteca from '#lib/components/pages/biblioteca/Biblioteca.svelte';
import TrackSheet from '#lib/components/pages/biblioteca/TrackSheet.svelte';
import MeterBridge from '#lib/components/pages/biblioteca/MeterBridge.svelte';
import { sheetSvg, sheetPng } from '#lib/components/pages/biblioteca/sheet-export.ts';

// Before integration, layer this task's staging keys over generated shared copy. After the
// merge deletes staging, the same tests consume the merged catalogs and generated functions.
vi.mock('#lib/paraglide/messages.js', async (importOriginal) => {
	const original = await importOriginal<typeof import('#lib/paraglide/messages.js')>();
	const { getLocale } = await import('#lib/paraglide/runtime.js');
	const catalogs = import.meta.glob<Record<string, string>>(
		[
			'../../../../messages/_staging/T2.11.*.json',
			'../../../../messages/_staging/FUX.P1.*.json',
			'../../../../messages/pt-BR.json',
			'../../../../messages/en-US.json'
		],
		{ eager: true, import: 'default' }
	);
	const catalog = (locale: string) =>
		Object.assign(
			{},
			...Object.entries(catalogs)
				.filter(
					([path]) =>
						path.endsWith(`/${locale}.json`) ||
						path.endsWith(`/T2.11.${locale}.json`) ||
						path.endsWith(`/FUX.P1.${locale}.json`)
				)
				// Main catalogs first, staging on top.
				.sort(([a], [b]) => Number(a.includes('_staging')) - Number(b.includes('_staging')))
				.map(([, values]) => values)
		) as Record<string, string>;
	const pt = catalog('pt-BR');
	const en = catalog('en-US');
	const task = Object.fromEntries(
		Object.keys(pt)
			.filter((key) => key.startsWith('biblioteca_'))
			.map((key) => [
				key,
				(values: Record<string, string | number> = {}) =>
					(getLocale() === 'en-US' ? en : pt)[key].replace(/\{(\w+)\}/g, (_, name: string) =>
						String(values[name] ?? '')
					)
			])
	);
	return { ...original, m: { ...original.m, ...task } };
});

afterEach(async () => {
	await cleanup();
	await setLocale('pt-BR', { reload: false });
});

async function accessible(container: HTMLElement) {
	const result = await axe.run(container);
	expect(
		result.violations.filter(({ impact }) => impact === 'serious' || impact === 'critical')
	).toEqual([]);
}

/** Plan codes (S1…S10, T…, F…) never reach visible copy (spec §4.1, T15). */
const PLAN_CODE = /(^|[\s(])(S\d{1,2}|T\d+\.\d+|F\d+)(\s*[·/]|\s|$)/;

for (const copy of [
	{
		locale: 'pt-BR',
		title: 'Biblioteca',
		search: 'Registro de fitas / busca',
		sheet: 'Folha de pistas',
		close: 'Fechar ficha',
		data: 'DADOS',
		yourCurve: 'Sua curva: ',
		pack: 'Os 4 masters · Vol. 01',
		license: 'licença: a confirmar',
		correlator: 'Correlator'
	},
	{
		locale: 'en-US',
		title: 'Library',
		search: 'Tape log / search',
		sheet: 'Track sheet',
		close: 'Close sheet',
		data: 'DATA',
		yourCurve: 'Your curve: ',
		pack: 'The 4 masters · Vol. 01',
		license: 'license: pending',
		correlator: 'Correlator'
	}
] as const) {
	test(`archive, search, keyboard sheet and axe in ${copy.locale}`, async () => {
		await setLocale(copy.locale, { reload: false });
		const screen = await render(Biblioteca, { origin: 'https://example.test' });
		await expect
			.element(page.getByRole('heading', { name: copy.title, exact: true }))
			.toBeVisible();
		expect(screen.container.querySelectorAll('.tape')).toHaveLength(11);
		const console_ = screen.container.querySelector('.console');
		expect(console_?.textContent).toContain(copy.data);
		expect(console_?.textContent).toContain(copy.correlator);
		expect(console_?.textContent).not.toMatch(/S4\s*·/);
		// Shelf cards: MASTER n / 11, ±15 axis with 20 / 1k / 20k, licence and RMS footer.
		const first = screen.container.querySelector('.tape');
		expect(first?.querySelector('.serial')?.textContent).toMatch(/^MASTER \d{2} \/ 11$/);
		expect([...(first?.querySelectorAll('.mini-y span') ?? [])].map((n) => n.textContent)).toEqual([
			'+15',
			'0',
			'−15'
		]);
		expect([...(first?.querySelectorAll('.mini-x span') ?? [])].map((n) => n.textContent)).toEqual([
			'20',
			'1k',
			'20k'
		]);
		expect(first?.querySelector('.tape-bottom')?.textContent).toContain(copy.license);
		expect(first?.querySelector('.tape-bottom')?.textContent).toMatch(/RMS \d/);
		expect(screen.container.querySelector('.pack-box h4')?.textContent).toBe(copy.pack);
		expect(screen.container.textContent).not.toContain('S9');
		expect(screen.container.textContent ?? '').not.toMatch(PLAN_CODE);
		// "Sua curva: <nome>" comes from the existing editor state (the Neutral fallback here).
		const option = screen.container.querySelector<HTMLOptionElement>('option[value="current"]');
		expect(option?.textContent?.startsWith(copy.yourCurve)).toBe(true);
		// Runtime not mounted yet (FUX.2: client null): the local shelf shows skeleton cards.
		expect(
			screen.container.querySelector('[data-tour="biblioteca-shelf"] [aria-busy="true"]')
		).not.toBeNull();
		expect(screen.container.querySelector('[data-tour="biblioteca-card"]')).not.toBeNull();
		await accessible(screen.container);
		await page.getByRole('searchbox', { name: copy.search }).fill('Auri');
		expect(screen.container.querySelectorAll('.tape')).toHaveLength(1);
		expect(screen.container.querySelector('.pack-box')).toBeNull();
		const open = page.getByRole('button', { name: /Auri/ });
		await expect.element(open).toHaveAccessibleName(/MASTER 01 \/ 11.*Auri.*preset:padrao/);
		await open.click();
		await expect.element(page.getByRole('dialog')).toBeVisible();
		await expect
			.element(page.getByRole('heading', { name: copy.sheet, exact: true }))
			.toBeVisible();
		const qr = screen.container.querySelector<HTMLImageElement>('.print-card img');
		expect(qr?.src).toContain('data:image/svg+xml,');
		const link = screen.container.querySelector<HTMLAnchorElement>('.print-card a');
		expect(link?.href).toContain('https://example.test/#p=');
		expect(screen.container.querySelectorAll('tbody tr')).toHaveLength(10);
		expect(screen.container.querySelector('[data-tour="biblioteca-share"]')).not.toBeNull();
		await accessible(screen.container);
		await expect.element(page.getByRole('button', { name: copy.close, exact: true })).toHaveFocus();
		await userEvent.keyboard('{Escape}');
		expect(screen.container.querySelector('dialog')).toBeNull();
		await expect.element(open).toHaveFocus();
	}, 15000);
}

test('untrusted local names stay text in the sheet and card, never HTML', async () => {
	const tape: Tape = {
		...archiveTapes([])[0],
		id: 'local:unsafe',
		group: 'local',
		source: 'custom',
		name: '<img src=x onerror=alert(1)>'
	};
	const screen = await render(TrackSheet, {
		tape,
		current: neutralCurve(),
		origin: 'https://example.test',
		locale: 'pt-BR',
		app: null,
		verdict: null,
		audioState: { ...IDLE_STATE },
		onClose: vi.fn(),
		onStatus: vi.fn()
	});
	expect(screen.container.querySelector('h2')?.textContent).toBe(tape.name);
	expect(screen.container.querySelector('img[src="x"]')).toBeNull();
	expect(screen.container.querySelector('.print-card strong')?.textContent).toBe(tape.name);
	await accessible(screen.container);
});

test('every unavailable sheet control states its reason instead of a bare disabled', async () => {
	const screen = await render(TrackSheet, {
		tape: archiveTapes([])[0],
		current: neutralCurve(),
		origin: 'https://example.test',
		locale: 'pt-BR',
		app: null,
		verdict: null,
		audioState: { ...IDLE_STATE },
		onClose: vi.fn(),
		onStatus: vi.fn()
	});
	const buttons = [...screen.container.querySelectorAll<HTMLButtonElement>('.sheet-body button')];
	expect(buttons.some((button) => button.disabled)).toBe(false);
	const write = buttons.find((button) => button.textContent?.includes('Gravar com checklist'));
	expect(write?.getAttribute('aria-disabled')).toBe('true');
	expect(write?.getAttribute('aria-describedby')).toBeTruthy();
	const stop = buttons.find((button) => button.textContent?.includes('Parar prévia'));
	expect(stop?.getAttribute('aria-disabled')).toBe('true');
	// Explainers next to the curve code, the technical sheet and the A/B.
	expect(screen.container.querySelectorAll('.head-row, .envelope-row')).toHaveLength(3);
	await accessible(screen.container);
});

test('the bridge uses real frame fields in LIVE and returns to calculated DATA, not simulated audio', async () => {
	// Copy follows the Paraglide locale; the `locale` prop only formats numbers (the page passes
	// getLocale() for both), so the test sets both to en-US.
	await setLocale('en-US', { reload: false });
	const curve = neutralCurve();
	const frame = {
		vuL: -1,
		vuR: -2,
		ppmL: -15,
		ppmR: -16,
		truePeakDb: -14,
		lufsM: -18,
		lufsS: -19,
		correlation: 0.7,
		active: true
	};
	const screen = await render(MeterBridge, {
		curve,
		current: curve,
		verdict: null,
		locale: 'en-US',
		update: { mode: 'live', frame }
	});
	expect(screen.container.querySelector('.console')?.getAttribute('data-mode')).toBe('live');
	expect(screen.container.querySelector('.chip')?.getAttribute('data-mode')).toBe('live');
	expect(screen.container.querySelector('[aria-label="VU L"]')?.getAttribute('aria-valuenow')).toBe(
		'-1'
	);
	expect(screen.container.querySelector('[aria-label="VU R"]')?.getAttribute('aria-valuenow')).toBe(
		'-2'
	);
	expect(screen.container.querySelector('[data-testid="lufs-m"]')?.textContent).toContain('18');
	await accessible(screen.container);
	await screen.rerender({ update: { mode: 'data', frame: null } });
	expect(screen.container.querySelector('.console')?.getAttribute('data-mode')).toBe('data');
	expect(screen.container.querySelector('.chip')?.getAttribute('data-mode')).toBe('data');
	expect(screen.container.querySelectorAll('.dial')).toHaveLength(5);
	expect(screen.container.querySelector('.data-meters')?.textContent).toContain('∅');
	// Same curve against itself: RMS 0 → correlator +1,00, calculated (not audio).
	expect(screen.container.querySelector('.data-meters')?.textContent).toContain('Correlator');
	expect(screen.container.querySelector('.data-meters')?.textContent).toContain('+1.00');
	expect(screen.container.querySelector('.meter-note')?.textContent).toContain('RMS difference');
	expect(screen.container.querySelector('.console')?.textContent).not.toMatch(/S4\s*·/);
	expect(screen.container.querySelector('[aria-label="VU L"]')).toBeNull();
	// A live mode without a frame is never AO VIVO.
	await screen.rerender({ update: { mode: 'live', frame: null } });
	expect(screen.container.querySelector('.console')?.getAttribute('data-mode')).toBe('data');
});

test('sheet PNG rasterizes the complete sheet SVG through canvas', async () => {
	const tape = archiveTapes([])[0];
	const svg = sheetSvg(tape, 'https://example.test', 'en-US', {
		title: 'Track sheet',
		response: 'Electrical response',
		preamp: 'Preamp',
		track: 'Track',
		frequency: 'Frequency / Hz',
		gain: 'Gain / dB',
		license: 'license: pending confirmation',
		card: 'Curve card'
	});
	const blob = await sheetPng(svg);
	expect(blob.type).toBe('image/png');
	expect(blob.size).toBeGreaterThan(1000);
	const bitmap = await createImageBitmap(blob);
	expect(bitmap.width).toBe(2400);
	expect(bitmap.height).toBe(2300);
	bitmap.close();
});
