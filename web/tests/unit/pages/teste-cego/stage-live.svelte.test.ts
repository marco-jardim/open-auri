// The stage moves only with real audio (plan §0.12.7). Without meter frames every bay rests in
// DATA: dark, no level, nothing animating. With live frames (a fake meter source standing in for
// the preview's pre-volume tap) the playing bay's level follows them frame by frame, and only that
// bay. Reduced motion: no ripple, no size change, a brightness step updated at most at 10 Hz.
import { flushSync } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render } from 'vitest-browser-svelte';
import Stage from '#lib/components/pages/teste-cego/Stage.svelte';
import type { MeterFrame, MeterListener, MeterSource, MeterUpdate } from '#lib/audio/meters.ts';
import { m } from '#lib/paraglide/messages.js';
import '../../primitives/design-system.ts';

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
});

/** A meter source the test feeds by hand: nothing reaches the stage unless the test emits it. */
function fakeMeter() {
	const listeners = new Set<MeterListener>();
	const source: MeterSource = {
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
	};
	return {
		source,
		listeners,
		emit(update: MeterUpdate) {
			for (const listener of listeners) listener(update);
			flushSync();
		}
	};
}

/** A live frame whose louder PPM channel is `db` dBFS. */
function live(db: number): MeterUpdate {
	const frame: MeterFrame = {
		vuL: db,
		vuR: db,
		ppmL: db,
		ppmR: db - 6,
		truePeakDb: db,
		lufsM: db,
		lufsS: db,
		correlation: 1,
		active: true
	};
	return { mode: 'live', frame };
}
const DATA: MeterUpdate = { mode: 'data', frame: null };

/** The stage's own animations and transitions now running (the decorative art layer excluded). */
function running(stage: Element): Animation[] {
	return stage.getAnimations({ subtree: true }).filter((animation) => {
		const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
		return animation.playState === 'running' && !target?.closest('.art-layer');
	});
}

function parts(container: HTMLElement) {
	const stage = container.querySelector<HTMLElement>('.stage');
	if (!stage) throw new Error('Missing stage');
	const bays = [...stage.querySelectorAll<HTMLElement>('.btn.cego-bay')];
	const cabs = [...stage.querySelectorAll<HTMLElement>('.cab')];
	const halos = [...stage.querySelectorAll<HTMLElement>('.halo')];
	return { stage, bays, cabs, halos };
}

async function expectAtRest(container: HTMLElement) {
	const { stage, bays, cabs, halos } = parts(container);
	expect(bays).toHaveLength(3);
	for (const bay of bays) {
		expect(bay.getAttribute('data-mode')).toBe('data');
		expect(bay.hasAttribute('data-level')).toBe(false);
	}
	for (const cab of cabs) expect(cab.getAttribute('data-live')).toBe('false');
	for (const halo of halos) expect(getComputedStyle(halo).opacity).toBe('0');
	expect(stage.querySelectorAll('.ripple')).toHaveLength(0);
	expect(stage.style.getPropertyValue('--lvl')).toBe('0');
	const mode = stage.querySelector('.mode');
	expect(mode?.getAttribute('data-mode')).toBe('data');
	expect(mode?.textContent?.trim()).toBe(m.meter_mode_data());
	await expect.poll(() => running(stage).length).toBe(0);
}

test('without audio every bay rests in DATA, dark and still, idle or settled', async () => {
	const screen = await render(Stage, { onselect: vi.fn(), reducedMotion: false });
	await expectAtRest(screen.container);
	// Settled on a position with nothing playing: its lamp is on, its cabinet stays dark.
	await screen.rerender({ disabled: false, selected: 1 });
	await expectAtRest(screen.container);
	expect(
		[...screen.container.querySelectorAll('.fixture')].map((lamp) => lamp.getAttribute('data-on'))
	).toEqual(['false', 'true', 'false']);
	// A source that only says DATA changes nothing.
	const meter = fakeMeter();
	await screen.rerender({ meter: meter.source });
	meter.emit(DATA);
	await expectAtRest(screen.container);
});

test('live frames drive the playing bay level, frame by frame, and only that bay', async () => {
	const meter = fakeMeter();
	const screen = await render(Stage, {
		onselect: vi.fn(),
		disabled: false,
		selected: 1,
		meter: meter.source,
		reducedMotion: false
	});
	const { stage, bays, cabs, halos } = parts(screen.container);
	expect(meter.listeners.size).toBe(1);
	const others = () => [bays[0], bays[2]].map((bay) => bay?.getAttribute('data-mode'));

	meter.emit(live(-12)); // (−12 + 48) / 48
	expect(bays[1]?.getAttribute('data-mode')).toBe('live');
	expect(bays[1]?.getAttribute('data-level')).toBe('0.75');
	expect(others()).toEqual(['data', 'data']);
	expect(cabs.map((cab) => cab.getAttribute('data-live'))).toEqual(['false', 'true', 'false']);
	expect(stage.style.getPropertyValue('--lvl')).toBe('0.75');
	expect(stage.querySelector('.mode')?.textContent?.trim()).toBe(m.meter_mode_live());
	const bright = Number(getComputedStyle(halos[1]!).opacity);
	expect(bright).toBeCloseTo(0.18 + 0.75 * 0.82, 2);
	expect(getComputedStyle(halos[0]!).opacity).toBe('0');
	const ripple = stage.querySelector('.ripple');
	expect(ripple).not.toBeNull();
	expect(Number(getComputedStyle(ripple!).opacity)).toBeCloseTo(0.45, 2);
	if (matchMedia('(prefers-reduced-motion: no-preference)').matches) {
		expect(getComputedStyle(cabs[1]!.querySelector('.cone')!).transform).not.toBe('none');
	}

	meter.emit(live(-36));
	expect(bays[1]?.getAttribute('data-level')).toBe('0.25');
	expect(Number(getComputedStyle(halos[1]!).opacity)).toBeLessThan(bright);
	meter.emit(live(0));
	expect(bays[1]?.getAttribute('data-level')).toBe('1.00');
	meter.emit(live(-90));
	expect(bays[1]?.getAttribute('data-level')).toBe('0.00');

	// The frames stop: back to DATA at once, nothing left moving.
	meter.emit(DATA);
	await expectAtRest(screen.container);

	// While the test swaps positions the stage is dark whatever arrives, and the source is dropped.
	await screen.rerender({ moving: true });
	meter.emit(live(-6));
	for (const bay of bays) expect(bay.getAttribute('data-mode')).toBe('data');
	expect(stage.querySelectorAll('.ripple')).toHaveLength(0);
	await screen.rerender({ moving: false, meter: null });
	expect(meter.listeners.size).toBe(0);
	expect(bays[1]?.getAttribute('data-mode')).toBe('data');
});

test('reduced motion: no ripple, no size change, a brightness step at most ten times a second', async () => {
	const meter = fakeMeter();
	const screen = await render(Stage, {
		onselect: vi.fn(),
		disabled: false,
		selected: 0,
		meter: meter.source,
		reducedMotion: true
	});
	const { stage, bays, cabs, halos } = parts(screen.container);

	meter.emit(live(-12));
	expect(bays[0]?.getAttribute('data-mode')).toBe('live');
	expect(bays[0]?.getAttribute('data-level')).toBe('0.75');
	expect(stage.querySelectorAll('.ripples, .ripple')).toHaveLength(0);
	expect(getComputedStyle(cabs[0]!.querySelector('.cone')!).transform).toBe('none');
	expect(getComputedStyle(halos[0]!).transform).toBe('none');
	expect(Number(getComputedStyle(halos[0]!).opacity)).toBeCloseTo(0.18 + 0.75 * 0.82, 2);
	expect(running(stage)).toHaveLength(0);

	// A new frame right away does not repaint: the next step waits for the 100 ms window.
	meter.emit(live(-40)); // 0.167, shown as the 0.25 step
	expect(bays[0]?.getAttribute('data-level')).toBe('0.75');
	await expect.poll(() => bays[0]?.getAttribute('data-level')).toBe('0.25');
	for (const db of [-3, -20, -30, -47]) {
		meter.emit(live(db));
		await new Promise((done) => setTimeout(done, 120));
		const level = Number(bays[0]?.getAttribute('data-level'));
		expect(Number.isInteger(level * 4)).toBe(true);
	}
	expect(stage.querySelectorAll('.ripples, .ripple')).toHaveLength(0);
	expect(running(stage)).toHaveLength(0);
	meter.emit(DATA);
	expect(bays[0]?.getAttribute('data-mode')).toBe('data');
	expect(bays[0]?.hasAttribute('data-level')).toBe(false);
});
