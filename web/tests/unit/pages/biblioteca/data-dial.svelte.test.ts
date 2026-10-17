import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render } from 'vitest-browser-svelte';
import DataDial from '#lib/components/pages/biblioteca/DataDial.svelte';

afterEach(async () => {
	await cleanup();
	vi.useRealTimers();
});

/** Needle transform: the DataDial expression on the −30…+3 face, so floats match exactly. */
function needleAt(value: number, min = -30, max = 3): string {
	return `rotate(${-50 + 100 * Math.max(0, Math.min(1, (value - min) / (max - min)))} 100 112)`;
}

function faceOf(container: HTMLElement): string[] {
	return [...container.querySelectorAll('svg > :not(.needle)')].map((node) => node.outerHTML);
}

const LEVEL = {
	label: 'Level',
	value: -6,
	min: -30,
	max: 3,
	locale: 'en-US' as const,
	liveUnit: 'VU'
};

test('the face is the same in DATA and LIVE; the live needle follows every frame, no easing', async () => {
	const screen = await render(DataDial, { ...LEVEL, live: null, reducedMotion: false });
	const idleFace = faceOf(screen.container);
	const needle = () => screen.container.querySelector('.needle');
	expect(needle()?.getAttribute('transform')).toBe(needleAt(-6));
	await screen.rerender({ live: 0 });
	expect(screen.container.querySelector('.dial')?.getAttribute('data-mode')).toBe('live');
	expect(faceOf(screen.container)).toEqual(idleFace);
	expect(needle()?.getAttribute('transform')).toBe(needleAt(0));
	const live = needle();
	if (!live) throw new Error('Missing live needle');
	expect(getComputedStyle(live).transitionDuration).toBe('0s');
	expect(getComputedStyle(live).animationName).toBe('none');
	await screen.rerender({ live: -8 });
	expect(needle()?.getAttribute('transform')).toBe(needleAt(-8));
	// Readings beyond the face clamp only the drawing.
	await screen.rerender({ live: -120 });
	expect(needle()?.getAttribute('transform')).toBe(needleAt(-30));
	expect(faceOf(screen.container)).toEqual(idleFace);
});

test('reduced motion keeps the live needle and moves it with the readout at 10 Hz', async () => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
	const screen = await render(DataDial, { ...LEVEL, live: 0, reducedMotion: true });
	const readout = screen.container.querySelector('output');
	const needle = () => screen.container.querySelector('.needle')?.getAttribute('transform');
	expect(needle()).toBe(needleAt(0));
	expect(readout?.textContent).toBe('0.0 VU');
	await screen.rerender({ live: -3 });
	await screen.rerender({ live: -9 });
	await vi.advanceTimersByTimeAsync(99);
	await tick();
	// Inside the 100 ms window neither the needle nor the number moves.
	expect(needle()).toBe(needleAt(0));
	expect(readout?.textContent).toBe('0.0 VU');
	await vi.advanceTimersByTimeAsync(1);
	await tick();
	// Both land together on the latest real reading.
	expect(needle()).toBe(needleAt(-9));
	expect(readout?.textContent).toBe('−9.0 VU');
	// A burst of frames moves the needle at most once per 100 ms (plus the trailing one).
	let changes = 0;
	const observer = new MutationObserver((records) => {
		changes += records.filter((record) => record.attributeName === 'transform').length;
	});
	const path = screen.container.querySelector('.needle');
	if (path) observer.observe(path, { attributes: true });
	const start = performance.now();
	for (let i = 0; i < 30; i++) {
		await screen.rerender({ live: -20 + i / 2 });
		await vi.advanceTimersByTimeAsync(10);
		await tick();
	}
	await vi.advanceTimersByTimeAsync(150);
	await tick();
	observer.disconnect();
	expect(changes).toBeGreaterThan(0);
	expect(changes).toBeLessThanOrEqual(Math.ceil((performance.now() - start) / 100) + 1);
	// No incoming frames means no autonomous updates.
	const liveMarkup = screen.container.innerHTML;
	await vi.advanceTimersByTimeAsync(1000);
	await tick();
	expect(screen.container.innerHTML).toBe(liveMarkup);
	// Back to DATA: the calculated value, static, on the same face.
	await screen.rerender({ live: null });
	expect(screen.container.querySelector('.dial')?.getAttribute('data-mode')).toBe('data');
	expect(readout?.textContent).toBe('−6.0 dB');
	expect(needle()).toBe(needleAt(-6));
	const dataMarkup = screen.container.innerHTML;
	await vi.advanceTimersByTimeAsync(2000);
	await tick();
	expect(screen.container.innerHTML).toBe(dataMarkup);
});
