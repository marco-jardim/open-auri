import { expect, test, vi } from 'vitest';
import { LiveMeter } from '#lib/components/meters/live.svelte.ts';
import type { MeterListener, MeterSource } from '#lib/audio/meters.ts';

test('connecting null disconnects the previous source, resets the display and does not double unsubscribe', () => {
	const meter = new LiveMeter();
	const unsubscribe = vi.fn();
	let listener: MeterListener | undefined;
	const source: MeterSource = {
		subscribe(next) {
			listener = next;
			return unsubscribe;
		}
	};
	meter.connect(null);
	expect(meter.mode).toBe('data');
	meter.connect(source);
	listener?.({ frame: null, mode: 'live' });
	expect(meter.mode).toBe('live');
	meter.connect(null);
	expect(meter.frame).toBeNull();
	expect(meter.mode).toBe('data');
	expect(unsubscribe).toHaveBeenCalledOnce();
	meter.disconnect();
	expect(unsubscribe).toHaveBeenCalledOnce();
});
