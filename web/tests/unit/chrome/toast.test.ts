import { expect, test } from 'vitest';
import { get } from 'svelte/store';
import { createToastStore } from '#lib/components/chrome/toast.ts';

test('stores ordered messages with defaults, unique IDs, dismissal and clearing', () => {
	const store = createToastStore();
	const first = store.push('Curve saved');
	const second = store.push('Cable disconnected', { tone: 'error', duration: 0 });
	expect(get(store)).toEqual([
		{ id: first, message: 'Curve saved', tone: 'info', duration: 5000 },
		{ id: second, message: 'Cable disconnected', tone: 'error', duration: 0 }
	]);
	expect(second).not.toBe(first);
	store.dismiss(first);
	expect(get(store).map((item) => item.id)).toEqual([second]);
	store.dismiss(first);
	expect(get(store)).toHaveLength(1);
	store.clear();
	expect(get(store)).toEqual([]);
	expect(store.push('New notice', { tone: 'success', duration: 2000 })).toBeGreaterThan(second);
});

test('rejects blank messages and invalid durations without changing state', () => {
	const store = createToastStore();
	expect(() => store.push('  ')).toThrow(TypeError);
	for (const duration of [-1, Infinity, NaN]) {
		expect(() => store.push('Invalid', { duration })).toThrow(RangeError);
	}
	expect(get(store)).toEqual([]);
});

test('factory queues are independent and do not expire before being rendered', () => {
	const first = createToastStore();
	const second = createToastStore();
	first.push('Local to the first app');
	expect(get(first)).toHaveLength(1);
	expect(get(second)).toEqual([]);
});
