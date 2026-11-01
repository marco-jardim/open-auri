import { mount, tick, unmount, type ComponentProps } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { snapshotBands } from 'open-auri/dsp';
import { THRESHOLDS } from 'open-auri/safety';
import { createClientApp, type ClientApp } from '#lib/app/index.ts';
import { createGestureToken } from '#lib/cable/gesture.ts';
import { CABLE_LIVE_KEY } from '#lib/cable/service.ts';
import { planComparison } from '#lib/cable/compare.ts';
import CableCompare, { type CableCompareSide } from '#lib/components/cable/CableCompare.svelte';
import { formatNumber } from '#lib/components/cable/i18n.ts';
import { initialTracks } from '#lib/components/pages/comparar/comparison.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import { fakeAppOptions } from '../app/fakes.ts';
// The /comparar page's global stylesheet (all selectors under `.comparar`), loaded so the
// 360 px layout test sees the same cascade as the real page.
import '#lib/components/pages/comparar/comparar.css';

const sides = initialTracks()
	.slice(0, 2)
	.map((track) => ({
		key: String(track.id),
		name: track.curve.name,
		curve: track.curve
	}));
const [a, b] = sides;
let apps: ClientApp[] = [];
let disposers: (() => Promise<void>)[] = [];

beforeEach(async () => {
	localStorage.removeItem(CABLE_LIVE_KEY);
	await setLocale('pt-BR', { reload: false });
});

afterEach(async () => {
	await cleanup();
	for (const dispose of disposers) await dispose();
	for (const app of apps) app.dispose();
	apps = [];
	disposers = [];
	vi.restoreAllMocks();
	localStorage.removeItem(CABLE_LIVE_KEY);
});

async function setup(props: Partial<ComponentProps<typeof CableCompare>> = {}, renderNow = true) {
	const fake = fakeAppOptions();
	const app = createClientApp(fake.options);
	apps.push(app);
	await app.start();
	expect(await app.cable.connect()).not.toBeNull();
	vi.spyOn(app.cable, 'createGesture').mockImplementation(() =>
		createGestureToken(
			{ isTrusted: true, type: 'click' },
			{ now: () => fake.time.value, userActivation: null }
		)
	);
	const options = { app, a, b, match: true, ...props };
	if (renderNow) await render(CableCompare, options);
	await tick();
	return { app, fake, options };
}

async function openChecklist() {
	await page.getByRole('button', { name: m.cable_x2_start(), exact: true }).click();
	return page.getByRole('group', { name: m.cable_x2_checklist_title() });
}

async function start(app: ClientApp) {
	const group = await openChecklist();
	await group.getByRole('checkbox', { name: m.cable_confirm_volume() }).click();
	await group.getByRole('button', { name: m.cable_live_start() }).click();
	await vi.waitFor(() => expect(app.cableState.live?.comparison?.status).toBe('ready'));
}

function playingCrc(fake: ReturnType<typeof fakeAppOptions>) {
	const payload = fake.device.firmware.live;
	return payload === null ? null : (payload[218] ?? 0) | ((payload[219] ?? 0) << 8);
}

test('first=1 applies B first, with no flash commit', async () => {
	const { app, fake } = await setup({ first: 1 });
	await start(app);
	expect(app.cableState.live?.comparison?.index).toBe(1);
	expect(playingCrc(fake)).toBe(
		planComparison(
			sides.map((side) => side.curve),
			{ match: true }
		).items[1]?.crc
	);
	expect(fake.device.firmware.commitCount).toBe(0);
});

test('keys=false ignores A, B and Space window shortcuts', async () => {
	const { app } = await setup({ keys: false });
	await start(app);
	const switchComparison = vi.spyOn(app.cable, 'switchComparison');
	(document.activeElement as HTMLElement | null)?.blur();
	for (const key of ['a', 'b', ' ']) {
		document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
	}
	await tick();
	await app.cable.whenLiveIdle();
	expect(switchComparison).not.toHaveBeenCalled();
	expect(app.cableState.live?.comparison?.index).toBe(0);
	// No keys, no keyboard hint: the lever is not described by it either.
	expect(document.querySelector('[data-cable-ab-keys]')).toBeNull();
	expect(document.body.textContent).not.toContain(m.cable_x2_keys());
	expect(document.querySelector('[data-cable-ab-lever]')?.hasAttribute('aria-describedby')).toBe(
		false
	);
});

test('with keys the lever is described by the keyboard hint', async () => {
	const { app } = await setup();
	await start(app);
	const lever = document.querySelector('[data-cable-ab-lever]');
	const described = lever?.getAttribute('aria-describedby') ?? '';
	expect(described).not.toBe('');
	expect(document.getElementById(described)?.textContent?.trim()).toBe(m.cable_x2_keys());
});

function deferred() {
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { gate, release };
}

/** `startComparison`'s next call runs (and publishes), but resolves only on `release`. */
function holdStart(app: ClientApp) {
	const original = app.cable.startComparison.bind(app.cable);
	const { gate, release } = deferred();
	const spy = vi.spyOn(app.cable, 'startComparison').mockImplementationOnce(async (options) => {
		const outcome = await original(options);
		await gate;
		return outcome;
	});
	return { spy, release };
}

/** `switchComparison`'s next call runs, but resolves only on `release`. */
function holdSwitch(app: ClientApp) {
	const original = app.cable.switchComparison.bind(app.cable);
	const { gate, release } = deferred();
	const spy = vi.spyOn(app.cable, 'switchComparison').mockImplementationOnce(async (index) => {
		const result = await original(index);
		await gate;
		return result;
	});
	return { spy, release };
}

test('choose during the start is applied after it, never ending the new comparison', async () => {
	const onchoose = vi.fn();
	const { app, options } = await setup({ onchoose }, false);
	const component = mount(CableCompare, { target: document.body, props: options });
	disposers.push(() => unmount(component));
	await tick();
	const end = vi.spyOn(app.cable, 'endComparison');
	const switchComparison = vi.spyOn(app.cable, 'switchComparison');
	const held = holdStart(app);
	const group = await openChecklist();
	await group.getByRole('checkbox', { name: m.cable_confirm_volume() }).click();
	await group.getByRole('button', { name: m.cable_live_start() }).click();
	// The service published the session; `startComparison` has not resolved yet.
	await vi.waitFor(() => expect(app.cableState.live?.comparison?.status).toBe('ready'));
	expect(held.spy).toHaveBeenCalledOnce();
	await component.choose(1);
	expect(end).not.toHaveBeenCalled();
	expect(switchComparison).not.toHaveBeenCalled();
	expect(app.cableState.live?.comparison?.active).toBe(true);
	held.release();
	await vi.waitFor(() => {
		expect(app.cableState.live?.comparison?.index).toBe(1);
		expect(app.cableState.live?.comparison?.status).toBe('ready');
	});
	expect(switchComparison).toHaveBeenCalledExactlyOnceWith(1);
	expect(end).not.toHaveBeenCalled();
	expect(app.cableState.live?.comparison?.active).toBe(true);
	expect(document.querySelector('[data-cable-ab-ended]')).toBeNull();
	await vi.waitFor(() => expect(onchoose).toHaveBeenCalledExactlyOnceWith(1));
});

test('onchoose reports lever switches, never a choose that applied right away', async () => {
	const onchoose = vi.fn();
	const { app, options } = await setup({ onchoose }, false);
	const component = mount(CableCompare, { target: document.body, props: options });
	disposers.push(() => unmount(component));
	await tick();
	await start(app);
	await component.choose(1);
	expect(app.cableState.live?.comparison?.index).toBe(1);
	expect(onchoose).not.toHaveBeenCalled();
	const leverA = m.cable_x2_side({ side: 'A', name: a?.name ?? 'A' });
	await page.getByRole('radio', { name: leverA }).click();
	await vi.waitFor(() => expect(onchoose).toHaveBeenCalledExactlyOnceWith(0));
	expect(app.cableState.live?.comparison?.index).toBe(0);
});

test('a choose while a lever switch runs is queued, then applied and reported', async () => {
	const onchoose = vi.fn();
	const { app, options } = await setup({ onchoose }, false);
	const component = mount(CableCompare, { target: document.body, props: options });
	disposers.push(() => unmount(component));
	await tick();
	await start(app);
	const held = holdSwitch(app);
	const leverB = m.cable_x2_side({ side: 'B', name: b?.name ?? 'B' });
	await page.getByRole('radio', { name: leverB }).click();
	await vi.waitFor(() => expect(held.spy).toHaveBeenCalledOnce());
	// The page's A while the switch to B is in flight: queued, never dropped.
	await component.choose(0);
	expect(held.spy).toHaveBeenCalledOnce();
	held.release();
	await vi.waitFor(() => {
		expect(held.spy).toHaveBeenCalledTimes(2);
		expect(app.cableState.live?.comparison?.index).toBe(0);
		expect(app.cableState.live?.comparison?.status).toBe('ready');
	});
	expect(held.spy.mock.calls).toEqual([[1], [0]]);
	await vi.waitFor(() => expect(onchoose).toHaveBeenCalledExactlyOnceWith(0));
});

test('pairReason explains a missing pair (including equal side keys)', async () => {
	await setup({ b: a, pairReason: 'Escolha duas curvas distintas.' });
	const button = page.getByRole('button', { name: m.cable_x2_start(), exact: true });
	await expect.element(button).toHaveAttribute('aria-disabled', 'true');
	const described = button.element().getAttribute('aria-describedby') ?? '';
	expect(document.getElementById(described)?.textContent).toContain(
		'Escolha duas curvas distintas.'
	);
});

test('without matchToggle a level-range refusal never suggests an unavailable toggle', async () => {
	if (!a || !b) throw new Error('expected two sides');
	const off = snapshotBands(Array.from({ length: 10 }, () => ({ kind: 'OFF' as const })));
	const loud: CableCompareSide = {
		...a,
		curve: {
			...a.curve,
			bands: snapshotBands([{ kind: 'PK', freqHz: 1000, gainDb: 3, qFactor: 1 }, ...off.slice(1)]),
			preampDb: -6
		}
	};
	const quiet = { ...b, curve: { ...b.curve, bands: off, preampDb: THRESHOLDS.preampMinDb } };
	await setup({ a: loud, b: quiet });
	await openChecklist();
	const refusal = planComparison([loud.curve, quiet.curve], { match: true }).refusal;
	expect(refusal?.reason).toBe('level-range');
	expect(document.querySelector('[data-cable-ab-refusal] .gate-line')?.textContent?.trim()).toBe(
		m.cable_x2_refused_level_range_fixed({
			side: 'A',
			floor: formatNumber(THRESHOLDS.preampMinDb, 1),
			preamp: formatNumber(refusal?.preampDb ?? 0, 1)
		})
	);
});

test('onsave receives the original curve, side name and index after selecting the live cable', async () => {
	const plan = planComparison(
		sides.map((side) => side.curve),
		{ match: true }
	);
	const index = plan.items.findIndex((item) => item.matched);
	if (index !== 0 && index !== 1) throw new Error('expected a level-lowered side');
	const side = sides[index];
	if (!side) throw new Error('expected side');
	const onsave = vi.fn();
	const { app } = await setup({ first: index, onsave });
	const select = vi.spyOn(app.cable, 'selectLiveCable');
	await start(app);
	await page.getByRole('button', { name: m.cable_x2_save() }).click();
	expect(select).toHaveBeenCalledOnce();
	expect(onsave).toHaveBeenCalledExactlyOnceWith(
		{
			schema: 1,
			updatedAt: expect.any(Number),
			name: side.name,
			source: side.curve.source,
			labels: side.curve.labels ?? null,
			bands: side.curve.bands,
			preampDb: side.curve.preampDb
		},
		index,
		side.key
	);
	expect(app.pendingWrite).toBeNull();
});

test('ownEndedOnly hides a comparison ended by another instance but shows its own end', async () => {
	const { app, options } = await setup({ ownEndedOnly: true }, false);
	const outcome = await app.cable.startComparison({
		curves: sides.map((side) => side.curve),
		match: true,
		blind: false,
		confirmations: { volumeLowered: true },
		gesture: app.cable.createGesture({ isTrusted: true, type: 'click' })
	});
	expect(outcome.status).toBe('accepted');
	await app.cable.endComparison({ revert: false });
	await render(CableCompare, options);
	expect(document.querySelector('[data-cable-ab-ended]')).toBeNull();
	await start(app);
	await page.getByRole('button', { name: m.cable_x2_end_keep() }).click();
	await expect
		.poll(() => document.querySelector('[data-cable-ab-ended]')?.textContent?.trim())
		.toBe(m.cable_x2_ended_stopped());
});

test('exported choose switches only while running', async () => {
	const { app, options } = await setup({}, false);
	const component = mount(CableCompare, { target: document.body, props: options });
	disposers.push(() => unmount(component));
	await tick();
	const switchComparison = vi.spyOn(app.cable, 'switchComparison');
	await component.choose(1);
	expect(switchComparison).not.toHaveBeenCalled();
	await start(app);
	await component.choose(1);
	expect(switchComparison).toHaveBeenCalledExactlyOnceWith(1);
	expect(app.cableState.live?.comparison?.index).toBe(1);
	await app.cable.endComparison({ revert: false });
	await tick();
	await component.choose(0);
	expect(switchComparison).toHaveBeenCalledOnce();
});

test('inside /comparar at 360 px the start checklist stacks and every control is reachable', async () => {
	const restore = { width: window.innerWidth, height: window.innerHeight };
	await page.viewport(360, 760);
	try {
		const { options } = await setup({}, false);
		// Same ancestor as CompararPage, so its global `.comparar …` rules apply.
		const host = document.createElement('div');
		host.className = 'comparar';
		document.body.append(host);
		const component = mount(CableCompare, { target: host, props: options });
		disposers.push(async () => {
			await unmount(component);
			host.remove();
		});
		await tick();
		// Guard against a vacuous pass: the page stylesheet is really in the cascade.
		expect(getComputedStyle(host).maxWidth).toBe('1380px');
		const group = await openChecklist();
		await expect.element(group).toBeVisible();
		const checklist = document.querySelector<HTMLElement>('[data-cable-ab-checklist]');
		if (checklist === null) throw new Error('expected the checklist');
		// Regression: `.comparar .check { display: flex }` used to turn it into one unwrapped row.
		expect(getComputedStyle(checklist).display).toBe('grid');
		const title = checklist.querySelector('h4');
		const levers = checklist.querySelector('fieldset');
		if (title === null || levers === null) throw new Error('expected title and levers');
		expect(title.getBoundingClientRect().bottom).toBeLessThanOrEqual(
			levers.getBoundingClientRect().top
		);
		expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(360);
		expect(checklist.scrollWidth).toBeLessThanOrEqual(checklist.clientWidth);
		const controls = [
			group.getByRole('checkbox', { name: m.cable_confirm_volume() }).element(),
			group.getByRole('button', { name: m.cable_live_cancel() }).element(),
			group.getByRole('button', { name: m.cable_live_start() }).element()
		];
		for (const control of controls) {
			const box = control.getBoundingClientRect();
			expect(box.left).toBeGreaterThanOrEqual(0);
			expect(box.right).toBeLessThanOrEqual(360);
		}
	} finally {
		await page.viewport(restore.width, restore.height);
	}
});

test("in /comparar the page's lamp, readout and actions rules miss this panel", async () => {
	const restore = { width: window.innerWidth, height: window.innerHeight };
	await page.viewport(360, 760);
	try {
		const { app, options } = await setup({}, false);
		const host = document.createElement('div');
		host.className = 'comparar';
		// The page's own blend verdict, styled by those same rules: it must keep its look.
		const verdict = document.createElement('div');
		verdict.className = 'verdict ok';
		const verdictLamp = document.createElement('span');
		verdictLamp.className = 'lamp';
		const knobReadout = document.createElement('span');
		knobReadout.className = 'readout';
		verdict.append(verdictLamp, knobReadout);
		host.append(verdict);
		document.body.append(host);
		const component = mount(CableCompare, { target: host, props: options });
		disposers.push(async () => {
			await unmount(component);
			host.remove();
		});
		await tick();
		expect(getComputedStyle(host).maxWidth).toBe('1380px');
		// The page keeps its amber 22 px verdict lamp and its black monospace readout.
		const pageLamp = getComputedStyle(verdictLamp);
		expect(pageLamp.width).toBe('22px');
		expect(pageLamp.backgroundImage).toContain('rgb(242, 179, 61)');
		const pageReadout = getComputedStyle(knobReadout);
		expect(pageReadout.backgroundColor).toBe('rgb(13, 12, 11)');
		expect(pageReadout.fontFamily).toContain('JetBrains Mono');

		await openChecklist();
		const gateLamp = document.querySelector<HTMLElement>('[data-cable-ab-gate] .lamp');
		if (gateLamp === null) throw new Error('expected the gate lamp');
		const lamp = getComputedStyle(gateLamp);
		// Not `.comparar .lamp`: the page's grey 22 px bulb (#6a6560 → #2a2724).
		expect(lamp.backgroundImage).not.toContain('rgb(106, 101, 96)');
		expect(lamp.backgroundImage).not.toContain('rgb(42, 39, 36)');
		expect(lamp.width).not.toBe('22px');
		const checkActions = document.querySelector<HTMLElement>(
			'[data-cable-ab-checklist] .ab-actions'
		);
		if (checkActions === null) throw new Error('expected the checklist actions');
		// Not `.comparar .actions` (margin-top 14px, align-items end).
		expect(getComputedStyle(checkActions).marginTop).toBe('0px');
		expect(getComputedStyle(checkActions).alignItems).toBe('center');

		await start(app);
		const readout = document.querySelector<HTMLElement>('[data-cable-ab] .ab-readout');
		if (readout === null) throw new Error('expected the readout');
		const shown = getComputedStyle(readout);
		// Not `.comparar .readout`: a black, bordered, padded box (its own mono face is the panel's
		// `--face-data`, the same family in the app, so the family proves nothing).
		expect(shown.backgroundColor).not.toBe('rgb(13, 12, 11)');
		expect(shown.borderTopWidth).toBe('0px');
		expect(shown.paddingTop).toBe('0px');
		expect(document.querySelector('[data-cable-ab] .readout')).toBeNull();
		expect(document.querySelector('[data-cable-ab] .actions')).toBeNull();
		expect(document.querySelector('[data-cable-ab] .reasons')).toBeNull();
	} finally {
		await page.viewport(restore.width, restore.height);
	}
});

test('out-of-envelope curves are refused before any send or commit', async () => {
	if (!a) throw new Error('expected side A');
	const { app, fake } = await setup({ a: { ...a, curve: { ...a.curve, preampDb: -100 } } });
	const attempts = fake.device.attempts;
	const group = await openChecklist();
	expect(
		document.querySelector('[data-cable-ab-refusal]')?.getAttribute('data-cable-ab-refusal')
	).toBe('yolo-unsupported');
	await group.getByRole('checkbox', { name: m.cable_confirm_volume() }).click();
	const go = group.getByRole('button', { name: m.cable_live_start() });
	await expect.element(go).toHaveAttribute('aria-disabled', 'true');
	const element = go.element();
	if (!(element instanceof HTMLElement)) throw new Error('expected start button');
	element.click();
	await tick();
	expect(app.cableState.live).toBeNull();
	expect(fake.device.attempts).toBe(attempts);
	expect(fake.device.firmware.commitCount).toBe(0);
	expect(fake.device.firmware.live).toBeNull();
});
