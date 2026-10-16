import { vi } from 'vitest';
import { createCableService, type CableService } from '#lib/cable/service.ts';
import type { CableState, QueueOutcome } from '#lib/cable/types.ts';

/** Observable service boundary; never opens a picker or writes a device from component tests. */
export function cableUi(initial: Partial<CableState> = {}) {
	const base = createCableService({
		hid: null,
		journal: { append: () => undefined, last: () => null },
		flash: {
			get: () => ({ day: { date: null, count: 0 }, total: 0, lastWriteAt: 0, session: 0 }),
			record: () => undefined
		},
		now: () => 10_000,
		lastWrittenLevelDb: () => null,
		sessionWriteCount: () => 0
	});
	let state: CableState = { ...base.getState(), ...initial };
	const listeners = new Set<(state: CableState) => void>();
	function publish(next: Partial<CableState>) {
		state = { ...state, ...next };
		for (const listener of listeners) listener(state);
	}
	const connect = vi.fn<CableService['connect']>().mockResolvedValue(null);
	const disconnect = vi.fn<CableService['disconnect']>().mockResolvedValue(true);
	const selectDevice = vi.fn<CableService['selectDevice']>().mockReturnValue(true);
	const createGesture = vi
		.fn<CableService['createGesture']>()
		.mockReturnValue({ kind: 'cable-gesture' });
	const outcome: QueueOutcome = { status: 'done', simulated: true, items: [] };
	const writeQueue = vi.fn<CableService['writeQueue']>().mockResolvedValue(outcome);
	const dismissRescue = vi.fn(() => publish({ rescue: null }));
	const clearQueue = vi.fn(() => publish({ queue: null }));
	const unsubscribe = vi.fn();
	const service: CableService = {
		...base,
		getState: () => state,
		subscribe(listener) {
			listeners.add(listener);
			listener(state);
			return () => {
				listeners.delete(listener);
				unsubscribe();
			};
		},
		connect,
		disconnect,
		selectDevice,
		createGesture,
		writeQueue,
		dismissRescue,
		clearQueue
	};
	return {
		service,
		publish,
		connect,
		disconnect,
		selectDevice,
		createGesture,
		writeQueue,
		dismissRescue,
		clearQueue,
		unsubscribe
	};
}
