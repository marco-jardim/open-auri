import { describe, expect, test, vi } from 'vitest';
import { createTour, TOUR_STORAGE_KEY } from '#lib/comprehension/tour.svelte.ts';

function memory(initial: string | null = null) {
	const data = new Map<string, string>();
	if (initial !== null) data.set(TOUR_STORAGE_KEY, initial);
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => {
			data.set(key, value);
		},
		removeItem: (key: string) => {
			data.delete(key);
		}
	};
}

describe('local-only tour history', () => {
	test('SSR import and default auto-open are safe without a browser', () => {
		const controller = createTour();
		expect(controller.shouldAutoOpen('curva')).toBe(false);
		expect(controller.activePage).toBeNull();
	});

	test('first desktop visit opens; seen and dismissed pages stay closed across reloads', () => {
		const storage = memory();
		const environment = { storage: () => storage, isDesktop: () => true };
		const controller = createTour(environment);
		expect(controller.shouldAutoOpen('curva')).toBe(true);
		controller.open('curva');
		expect(controller.activePage).toBe('curva');
		expect(controller.shouldAutoOpen('cabo')).toBe(false);
		controller.markSeen('curva');
		controller.open('cabo');
		controller.dismiss('cabo');
		expect(JSON.parse(storage.getItem(TOUR_STORAGE_KEY) ?? '{}')).toEqual({
			curva: 'visto',
			cabo: 'dispensado'
		});
		const reloaded = createTour(environment);
		expect(reloaded.shouldAutoOpen('curva')).toBe(false);
		expect(reloaded.shouldAutoOpen('cabo')).toBe(false);
		expect(reloaded.shouldAutoOpen('comparar')).toBe(true);
		reloaded.open('cabo');
		expect(reloaded.activePage).toBe('cabo');
		reloaded.goTo(2);
		expect(reloaded.stepIndex).toBe(2);
		reloaded.open('cabo');
		expect(reloaded.stepIndex).toBe(0);
	});

	test('mobile never auto-opens, but manual open, page reset and full reset work', () => {
		const storage = memory();
		const controller = createTour({ storage: () => storage, isDesktop: () => false });
		expect(controller.shouldAutoOpen('curva')).toBe(false);
		controller.open('curva');
		expect(controller.activePage).toBe('curva');
		controller.markSeen('curva');
		controller.dismiss('cabo');
		controller.reset('curva');
		expect(controller.history).toEqual({ cabo: 'dispensado' });
		controller.reset();
		expect(controller.history).toEqual({});
		expect(storage.getItem(TOUR_STORAGE_KEY)).toBeNull();
	});

	for (const raw of ['', '{broken', 'null', '[]', '42', '{"curva":"yes"}']) {
		test(`corrupt history recovers without throwing: ${raw}`, () => {
			const storage = memory(raw);
			const controller = createTour({ storage: () => storage, isDesktop: () => true });
			expect(controller.shouldAutoOpen('curva')).toBe(true);
			expect(controller.storageError).toBe('corrupt');
			controller.dismiss('curva');
			expect(storage.getItem(TOUR_STORAGE_KEY)).toBe('{"curva":"dispensado"}');
		});
	}

	test('a partially corrupt history keeps the valid pages and says why it dropped one', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const storage = memory('{"curva":"visto","cabo":"yes","comparar":"dispensado","biblioteca":7}');
		const controller = createTour({ storage: () => storage, isDesktop: () => true });
		expect(controller.shouldAutoOpen('curva')).toBe(false);
		expect(controller.shouldAutoOpen('comparar')).toBe(false);
		expect(controller.shouldAutoOpen('cabo')).toBe(true);
		expect(controller.shouldAutoOpen('biblioteca')).toBe(true);
		expect(controller.history).toEqual({ curva: 'visto', comparar: 'dispensado' });
		expect(controller.storageError).toBe('corrupt');
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('tour:'), ['cabo', 'biblioteca']);
		controller.markSeen('cabo');
		expect(JSON.parse(storage.getItem(TOUR_STORAGE_KEY) ?? '{}')).toEqual({
			curva: 'visto',
			cabo: 'visto',
			comparar: 'dispensado'
		});
		warn.mockRestore();
	});

	test('storage failures are reported with context, never swallowed', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const denied = new Error('denied read');
		const storage = memory();
		storage.getItem = () => {
			throw denied;
		};
		const quota = new Error('quota');
		storage.setItem = () => {
			throw quota;
		};
		const controller = createTour({ storage: () => storage, isDesktop: () => true });
		controller.markSeen('curva');
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not read'), denied);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not store'), quota);
		warn.mockRestore();
	});

	test('unknown keys are not copied into state or written back', () => {
		const storage = memory('{"future":"visto","__proto__":{"curva":"visto"}}');
		const controller = createTour({ storage: () => storage, isDesktop: () => true });
		expect(controller.shouldAutoOpen('curva')).toBe(true);
		controller.markSeen('curva');
		expect(storage.getItem(TOUR_STORAGE_KEY)).toBe('{"curva":"visto"}');
	});

	test('blocked storage getter and write quota errors retain in-memory state', () => {
		const controller = createTour({
			storage: () => {
				throw new Error('storage blocked');
			},
			isDesktop: () => true
		});
		expect(controller.shouldAutoOpen('curva')).toBe(true);
		expect(controller.storageError).toBe('read');
		controller.dismiss('curva');
		expect(controller.storageError).toBe('write');
		expect(controller.shouldAutoOpen('curva')).toBe(false);
		controller.reset();
		expect(controller.shouldAutoOpen('curva')).toBe(true);
		const storage = memory();
		storage.setItem = () => {
			throw new Error('quota');
		};
		const quota = createTour({ storage: () => storage, isDesktop: () => true });
		quota.markSeen('cabo');
		expect(quota.history.cabo).toBe('visto');
		expect(quota.storageError).toBe('write');
	});

	test('missing storage also supports a complete in-memory session', () => {
		const controller = createTour({ storage: () => undefined, isDesktop: () => true });
		controller.open('curva');
		controller.markSeen('curva');
		expect(controller.shouldAutoOpen('curva')).toBe(false);
		controller.reset();
		expect(controller.shouldAutoOpen('curva')).toBe(true);
	});

	test('storage read and removal errors do not break the session', () => {
		const storage = memory();
		storage.getItem = () => {
			throw new Error('denied read');
		};
		storage.removeItem = () => {
			throw new Error('denied removal');
		};
		const controller = createTour({ storage: () => storage, isDesktop: () => true });
		expect(controller.shouldAutoOpen('curva')).toBe(true);
		expect(controller.storageError).toBe('read');
		controller.markSeen('curva');
		controller.reset();
		expect(controller.storageError).toBe('write');
		expect(controller.shouldAutoOpen('curva')).toBe(true);
		controller.goTo(Number.NaN);
		expect(controller.stepIndex).toBe(0);
		controller.goTo(-2);
		expect(controller.stepIndex).toBe(0);
	});
});
