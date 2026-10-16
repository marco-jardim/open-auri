import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { flushSync, tick } from 'svelte';
import { m } from '#lib/paraglide/messages.js';
import { getLocale } from '#lib/paraglide/runtime.js';
import type { MeterFrame, MeterListener, MeterSource, MeterUpdate } from '#lib/audio/meters.ts';
import VuMeter from '#lib/components/meters/VuMeter.svelte';
import { formatSigned, vuPosition } from '#lib/components/meters/format.ts';
import DataHarness from './DataHarness.svelte';
import LiveHarness from './LiveHarness.svelte';

afterEach(() => {
	vi.useRealTimers();
});

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function vuText(value: number): string {
	return m.meter_value_vu({ value: formatSigned(value, 1, getLocale()) });
}

const FRAME: MeterFrame = {
	vuL: -2,
	vuR: -2.5,
	ppmL: -16,
	ppmR: -17,
	truePeakDb: -15.8,
	lufsM: -17,
	lufsS: -18,
	correlation: 0.9,
	active: true
};

class FakeSource implements MeterSource {
	#listener: MeterListener | null = null;
	#current: MeterUpdate = { frame: null, mode: 'data' };
	subscribe(listener: MeterListener): () => void {
		this.#listener = listener;
		listener(this.#current);
		return () => {
			this.#listener = null;
		};
	}
	emit(update: MeterUpdate): void {
		this.#current = update;
		this.#listener?.(update);
	}
}

describe('meter components', () => {
	test('the DOM does not change over 1 s without data', async () => {
		const { container } = await render(DataHarness);
		await wait(50);
		const before = container.innerHTML;
		let mutations = 0;
		const observer = new MutationObserver((records) => {
			mutations += records.length;
		});
		observer.observe(container, {
			subtree: true,
			childList: true,
			attributes: true,
			characterData: true
		});
		await wait(1000);
		observer.disconnect();
		expect(mutations).toBe(0);
		expect(container.innerHTML).toBe(before);
		// Data mode shows curve values when given: the VU with data is a meter at −3 VU.
		const withData = container.querySelector('.vu-with-data');
		expect(withData?.getAttribute('role')).toBe('meter');
		expect(withData?.getAttribute('aria-valuenow')).toBe('-3');
	});

	test('the mode label switches when frames arrive', async () => {
		const source = new FakeSource();
		await render(LiveHarness, { props: { source } });
		const label = page.getByRole('status');
		await expect.element(label).toBeVisible();
		await expect.element(label).toHaveTextContent(m.meter_mode_data());
		await expect.element(label).toHaveAttribute('data-mode', 'data');

		flushSync(() => source.emit({ frame: FRAME, mode: 'live' }));
		await expect.element(label).toBeVisible();
		await expect.element(label).toHaveTextContent(m.meter_mode_live());
		await expect.element(label).toHaveAttribute('data-mode', 'live');

		flushSync(() => source.emit({ frame: null, mode: 'data' }));
		await expect.element(label).toBeVisible();
		await expect.element(label).toHaveTextContent(m.meter_mode_data());
	});

	test('the needle sits at the core VU reading with no added easing', async () => {
		const { container } = await render(VuMeter, {
			props: { mode: 'live', live: 0, reducedMotion: false }
		});
		const needle = container.querySelector('.oa-vu-needle');
		expect(needle).not.toBeNull();
		if (needle === null) return;
		expect(needle.getAttribute('transform')).toBe(`rotate(${-50 + 100 * vuPosition(0)} 100 112)`);
		expect(getComputedStyle(needle).transitionDuration).toBe('0s');
		expect(container.querySelector('[data-testid="vu-readout"]')).toBeNull();
	});

	test('reduced motion shows a numeric readout updated at 10 Hz and no needle', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
		const screen = await render(VuMeter, {
			props: { mode: 'live', live: 0, reducedMotion: true }
		});
		const { container } = screen;
		expect(container.querySelector('.oa-vu-needle')).toBeNull();
		const readout = container.querySelector('[data-testid="vu-readout"]');
		expect(readout?.textContent).toBe(vuText(0));

		// Two quick updates: the second lands inside the 100 ms window and is shown later.
		await screen.rerender({ live: -3 });
		await screen.rerender({ live: -6 });
		expect(readout?.textContent).not.toBe(vuText(-6));
		await vi.advanceTimersByTimeAsync(99);
		await tick();
		expect(readout?.textContent).toBe(vuText(0));
		await vi.advanceTimersByTimeAsync(1);
		await tick();
		expect(readout?.textContent).toBe(vuText(-6));

		// A burst of updates changes the number at most once per 100 ms (plus the trailing one).
		let changes = 0;
		const observer = new MutationObserver((records) => {
			changes += records.length;
		});
		if (readout !== null) {
			observer.observe(readout, { subtree: true, childList: true, characterData: true });
		}
		const start = performance.now();
		for (let i = 0; i < 30; i++) {
			// Every step is a distinct reading. A short cycle (e.g. i % 5) aliases with the 100 ms
			// window: the trailing commit would always sample the same value already on screen.
			await screen.rerender({ live: -20 + i / 2 });
			await vi.advanceTimersByTimeAsync(10);
			await tick();
		}
		await vi.advanceTimersByTimeAsync(150);
		await tick();
		const elapsed = performance.now() - start;
		observer.disconnect();
		expect(changes).toBeGreaterThan(0);
		expect(changes).toBeLessThanOrEqual(Math.ceil(elapsed / 100) + 1);
	});
});
