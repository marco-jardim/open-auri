// FUX.NAV acceptance for the global bar:
// 1. no horizontal overflow from 320 to 2560 px (the row never scrolls or pushes the page);
// 2. every destination and bar action is reachable by keyboard at each width (inline, through
//    "Mais" or "Carregar no editor", or through the mobile menu sheet), with 44 px touch
//    targets on mobile;
// 3. the space the bar's controls occupy (the union of their boxes in each row times the row
//    height, controls scrolled out of view included) is at most half of the pre-FUX.NAV bar's
//    at 1440 and 390 px. The old bar is LegacyBarFixture, measured in the same browser. Both the
//    footprint and the full bar box are logged with the "[FUX.NAV]" prefix for the report.
import axe from 'axe-core';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import BarFixture from './BarFixture.svelte';
import LegacyBarFixture from './LegacyBarFixture.svelte';
import { createPlaybackEngine } from './playback-fixture.ts';
// Real geometry needs the app's global styles (tokens, base, components), as the layout loads.
import '../primitives/design-system.ts';

// Includes SEEK.3's playback button, even when unavailable before a preview exists.
const CONTROLS = 'a[href], button, .cable-state';

const destinations = () => [
	m.chrome_nav_curve(),
	m.chrome_nav_library(),
	m.chrome_nav_compare(),
	m.chrome_nav_sound(),
	m.chrome_nav_community(),
	m.chrome_nav_blind(),
	m.chrome_nav_cable(),
	m.chrome_nav_docs()
];

const callbacks = () => ({
	onNeutro: vi.fn(),
	onPadraoAuri: vi.fn(),
	onWrite: vi.fn(),
	onAudio: vi.fn(),
	onHelp: vi.fn(),
	playbackEngine: createPlaybackEngine().engine
});

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
});

afterEach(async () => {
	await cleanup();
	await setLocale('pt-BR', { reload: false });
	await page.viewport(1440, 900);
});

/** Fonts, then a few frames: the bar's overflow guard fits on the next animation frame. */
async function settle(): Promise<void> {
	await document.fonts.ready;
	for (let frame = 0; frame < 3; frame++) {
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	}
}

function banner(): HTMLElement {
	const element = page.getByRole('banner').element();
	if (!(element instanceof HTMLElement)) throw new Error('Missing bar');
	return element;
}

/** Boxes of the controls a user sees or operates in the bar (closed menus excluded). */
function controlBoxes(root: HTMLElement): DOMRect[] {
	return [...root.querySelectorAll<HTMLElement>(CONTROLS)]
		.filter((element) => !element.closest('[hidden]'))
		.map((element) => element.getBoundingClientRect())
		.filter((rect) => rect.width > 1 && rect.height > 1);
}

interface Footprint {
	area: number;
	rows: number;
}

/** Σ over rows of (union of the controls' horizontal spans × the row's tallest control). */
function footprint(root: HTMLElement): Footprint {
	const centre = (box: DOMRect) => (box.top + box.bottom) / 2;
	const boxes = controlBoxes(root).sort((a, b) => centre(a) - centre(b));
	const rows: DOMRect[][] = [];
	for (const box of boxes) {
		const row = rows.at(-1);
		const first = row?.[0];
		if (row && first && Math.abs(centre(first) - centre(box)) <= 10) row.push(box);
		else rows.push([box]);
	}
	let area = 0;
	for (const row of rows) {
		const spans = row.map((box) => ({ start: box.left, end: box.right }));
		spans.sort((a, b) => a.start - b.start);
		let used = 0;
		let current: { start: number; end: number } | null = null;
		for (const span of spans) {
			if (current && span.start <= current.end) {
				current.end = Math.max(current.end, span.end);
				continue;
			}
			if (current) used += current.end - current.start;
			current = { ...span };
		}
		if (current) used += current.end - current.start;
		area += used * Math.max(...row.map((box) => box.height));
	}
	return { area: Math.round(area), rows: rows.length };
}

/** What a screen reader would call the focused control (aria-label, else visible text). */
function spoken(element: Element): string {
	const label = element.getAttribute('aria-label');
	if (label) return label.trim();
	const clone = element.cloneNode(true);
	if (!(clone instanceof Element)) return '';
	for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
	return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Arrow through an open menu (focus is on its first item), then Escape. */
async function collectMenu(reached: Set<string>): Promise<void> {
	await expect.poll(() => document.activeElement?.getAttribute('role')).toBe('menuitem');
	const first = document.activeElement;
	for (let step = 0; step < 12; step++) {
		if (document.activeElement) reached.add(spoken(document.activeElement));
		await userEvent.keyboard('{ArrowDown}');
		if (document.activeElement === first) break;
	}
	await userEvent.keyboard('{Escape}');
}

for (const locale of ['pt-BR', 'en-US'] as const) {
	const widths =
		locale === 'pt-BR'
			? [320, 390, 768, 1024, 1280, 1440, 1600, 1920, 2560]
			: [320, 390, 768, 1024, 1440, 1600];
	for (const width of widths) {
		test(`${locale}: no horizontal overflow at ${width} px`, async () => {
			await setLocale(locale, { reload: false });
			await page.viewport(width, 900);
			await render(BarFixture, callbacks());
			await settle();
			const header = banner();
			const row = header.firstElementChild;
			if (!(row instanceof HTMLElement)) throw new Error('Missing bar row');
			expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth);
			expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
			expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
				document.documentElement.clientWidth
			);
			const boxes = controlBoxes(header);
			expect(boxes.length).toBeGreaterThan(4);
			for (const box of boxes) {
				expect(box.left).toBeGreaterThanOrEqual(0);
				expect(box.right).toBeLessThanOrEqual(width);
				// One row, inside the bar.
				expect(box.top).toBeGreaterThanOrEqual(header.getBoundingClientRect().top);
				expect(box.bottom).toBeLessThanOrEqual(header.getBoundingClientRect().bottom);
				// Touch widths: 44 px targets (WCAG 2.5.5 / spec --hit).
				if (width <= 720) expect(box.height).toBeGreaterThanOrEqual(44);
			}
			expect(footprint(header).rows).toBe(1);
		});
	}
}

for (const width of [320, 390, 768, 1024, 1280, 1440]) {
	test(`every destination and bar action is reachable by keyboard at ${width} px`, async () => {
		await page.viewport(width, 900);
		await render(BarFixture, callbacks());
		await settle();
		const header = banner();
		const reached = new Set<string>();
		const stops: HTMLElement[] = [];

		// 1. Tab along the row, from the wordmark until focus leaves the bar.
		header.querySelector<HTMLElement>('.wordmark')?.focus();
		for (let step = 0; step < 40; step++) {
			const active = document.activeElement;
			if (!(active instanceof HTMLElement) || !header.contains(active)) break;
			stops.push(active);
			reached.add(spoken(active));
			await userEvent.keyboard('{Tab}');
		}
		expect(stops.length).toBeGreaterThan(3);

		// 2. Menus in the row open with Enter and are walked with the arrows. Their menu is a
		//    lazy chunk: the first Enter swaps the trigger for the Menu primitive's, so the
		//    trigger is found again by its class.
		for (const selector of ['.nav-more-trigger', '.tools-trigger']) {
			if (!stops.some((element) => element.matches(selector))) continue;
			header.querySelector<HTMLElement>(selector)?.focus();
			await userEvent.keyboard('{Enter}');
			await collectMenu(reached);
			expect(document.activeElement?.matches(selector)).toBe(true);
		}

		// 3. Mobile: the menu button opens the sheet; Tab walks it (focus is trapped inside).
		const menuButton = stops.find((element) => element.matches('.menu-btn'));
		if (width <= 720) expect(menuButton).toBeDefined();
		if (menuButton) {
			menuButton.focus();
			await userEvent.keyboard('{Enter}');
			const sheet = page.getByRole('dialog', { name: m.fuxnav_sheet_title() });
			await expect.element(sheet).toBeVisible();
			const dialog = sheet.element();
			for (let step = 0; step < 40; step++) {
				const active = document.activeElement;
				if (active instanceof HTMLElement && dialog.contains(active)) reached.add(spoken(active));
				await userEvent.keyboard('{Tab}');
			}
			expect(dialog.contains(document.activeElement)).toBe(true);
			await userEvent.keyboard('{Escape}');
			await expect.element(sheet).not.toBeInTheDocument();
			expect(document.activeElement).toBe(menuButton);
		}

		for (const destination of destinations()) expect(reached, destination).toContain(destination);
		for (const action of [
			m.chrome_write(),
			m.chrome_neutral(),
			m.chrome_default_auri(),
			m.chrome_audio(),
			m.transport_toggle_pause(),
			m.chrome_help_open(),
			m.auth_account_signin()
		]) {
			expect(reached, action).toContain(action);
		}
		expect([...reached].some((name) => name.includes(m.chrome_language_switch()))).toBe(true);
		// The cable status trigger (its popover holds the details).
		expect(reached, 'cable status').toContain(m.cable_status_disconnected());
	}, 30_000);
}

for (const viewport of [
	{ width: 1440, height: 900 },
	{ width: 390, height: 844 }
]) {
	test(`the bar's controls occupy at most half of the old bar's space at ${viewport.width} px`, async () => {
		await page.viewport(viewport.width, viewport.height);
		await render(LegacyBarFixture);
		await settle();
		const legacy = banner();
		const before = footprint(legacy);
		const beforeBox = legacy.getBoundingClientRect();
		await cleanup();

		await render(BarFixture, callbacks());
		await settle();
		const bar = banner();
		const after = footprint(bar);
		const afterBox = bar.getBoundingClientRect();
		const playback = bar.querySelector('.playback-btn');
		expect(playback).not.toBeNull();
		const playbackBox = playback!.getBoundingClientRect();
		expect(playbackBox.width).toBe(viewport.width <= 720 ? 44 : 32);
		expect(playbackBox.height).toBe(viewport.width <= 720 ? 44 : 32);
		const ratio = after.area / before.area;
		const box = (rect: DOMRect) =>
			`${Math.round(rect.width)}×${Math.round(rect.height)} = ${Math.round(rect.width * rect.height)} px²`;
		console.info(
			`[FUX.NAV] ${viewport.width}×${viewport.height}: footprint ${before.area} px² ` +
				`(${before.rows} rows) -> ${after.area} px² (${after.rows} row), ` +
				`${(ratio * 100).toFixed(1)}%; bar box ${box(beforeBox)} -> ${box(afterBox)}, ` +
				`height ${Math.round(beforeBox.height)} -> ${Math.round(afterBox.height)} px`
		);
		expect(after.rows).toBe(1);
		expect(ratio).toBeLessThanOrEqual(0.5);
		if (viewport.width <= 720) {
			// Brand and account, status, tools, navigation (more if a row wrapped).
			expect(before.rows).toBeGreaterThanOrEqual(4);
			expect(afterBox.height).toBeLessThanOrEqual(beforeBox.height / 2);
		} else {
			expect(afterBox.height).toBeLessThanOrEqual(48);
		}
	});
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// The guard reacts to real size changes only, and a fit that changes nothing writes nothing:
// after mount it settles in a few frames, then requests no frame and changes no DOM at all.
for (const scenario of [
	{ width: 1440, squeezed: false },
	{ width: 1024, squeezed: true },
	{ width: 390, squeezed: false }
]) {
	test(`the overflow guard settles, then stays quiet, at ${scenario.width} px${
		scenario.squeezed ? ' with content wider than the row' : ''
	}`, async () => {
		await page.viewport(scenario.width, 900);
		const frames = vi.spyOn(window, 'requestAnimationFrame');
		try {
			const preview = createPlaybackEngine();
			await render(BarFixture, { ...callbacks(), playbackEngine: preview.engine });
			const header = banner();
			if (scenario.squeezed) {
				// Wider content than the row holds: the guard has to fold (label, nav tiers…).
				const extra = document.createElement('span');
				extra.style.cssText = 'display: inline-block; width: 300px; height: 1px';
				header.querySelector('.bar-status')?.append(extra);
			}
			await wait(1000);
			const settling = frames.mock.calls.length;
			expect(settling, 'fit passes while settling').toBeLessThanOrEqual(6);
			if (scenario.squeezed) expect(header.dataset.squeeze ?? '').not.toBe('');
			else expect(header.dataset.squeeze ?? '').toBe('');

			const changes: MutationRecord[] = [];
			const watch = new MutationObserver((records) => changes.push(...records));
			watch.observe(header, {
				attributes: true,
				childList: true,
				characterData: true,
				subtree: true
			});
			// SEEK.3 subscribes to the playing engine: its 5 Hz position ticks must stay quiet too.
			for (let position = 1; position <= 5; position++) {
				preview.setState({ position });
				await wait(200);
			}
			watch.disconnect();
			expect(frames.mock.calls.length - settling, 'frames requested once settled').toBe(0);
			expect(changes.length, 'DOM changes once settled').toBe(0);
		} finally {
			frames.mockRestore();
		}
	});
}

async function expectAccessible(): Promise<void> {
	const { violations } = await axe.run(document.body);
	const blocking = violations.filter(({ impact }) => impact === 'serious' || impact === 'critical');
	expect(blocking).toEqual([]);
}

test('the bar, its "Mais" and tools menus and the mobile sheet pass axe', async () => {
	await render(BarFixture, callbacks());
	await settle();
	await expectAccessible();
	await page.getByRole('button', { name: m.fuxnav_more(), exact: true }).click();
	await expect.element(page.getByRole('menu')).toBeVisible();
	await expectAccessible();
	await userEvent.keyboard('{Escape}');
	await page.getByRole('button', { name: m.fuxnav_tools(), exact: true }).click();
	await expectAccessible();
	await userEvent.keyboard('{Escape}');
	await cleanup();

	await page.viewport(390, 844);
	await render(BarFixture, { ...callbacks(), currentPath: '/docs' });
	await settle();
	await expectAccessible();
	await page.getByRole('button', { name: m.fuxnav_menu_open(), exact: true }).click();
	await expect.element(page.getByRole('dialog', { name: m.fuxnav_sheet_title() })).toBeVisible();
	await expectAccessible();
}, 30_000);
