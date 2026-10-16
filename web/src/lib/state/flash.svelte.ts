import {
	FLASH_STORAGE_KEYS,
	parseFlashState,
	serializeFlashState,
	recordWrite,
	canWriteNow,
	dailyNotice,
	observeFlashState
} from 'open-auri/policy';
import { createStorage, type ClientStorage } from './storage.ts';
import type { Clock } from './model.ts';
import { storageStatus } from './status.svelte.ts';

export function createFlashStore(options: { storage?: ClientStorage; now?: Clock } = {}) {
	const storage = options.storage ?? createStorage();
	const status = storageStatus(storage);
	const now = options.now ?? Date.now;
	function load(persisted = false) {
		const read = persisted ? storage.readPersisted : storage.read;
		return parseFlashState({
			day: read('local', FLASH_STORAGE_KEYS.day),
			total: read('local', FLASH_STORAGE_KEYS.total),
			lastWriteAt: read('local', FLASH_STORAGE_KEYS.lastWriteAt),
			session: storage.read('session', FLASH_STORAGE_KEYS.session)
		});
	}
	const initial = observeFlashState(load(), now());
	let state = $state.raw(initial);
	// Persist the core's conservative cooldown anchor, including after corrupt storage.
	storage.write('local', FLASH_STORAGE_KEYS.lastWriteAt, serializeFlashState(initial).lastWriteAt);
	function refresh(persisted = false) {
		const incoming = load(persisted);
		if (incoming.lastWriteAt !== null && incoming.lastWriteAt >= (state.lastWriteAt ?? 0)) {
			state = { ...incoming, session: state.session };
			if (persisted) {
				for (const key of [
					FLASH_STORAGE_KEYS.day,
					FLASH_STORAGE_KEYS.total,
					FLASH_STORAGE_KEYS.lastWriteAt
				]) {
					storage.acceptExternal('local', key);
				}
			}
		}
	}
	function observe(at: number) {
		refresh();
		const next = observeFlashState(state, at);
		if (next.lastWriteAt !== state.lastWriteAt) {
			state = next;
			storage.write(
				'local',
				FLASH_STORAGE_KEYS.lastWriteAt,
				serializeFlashState(state).lastWriteAt
			);
		}
	}
	const stop = storage.onStorage((event) => {
		if (
			event.area === 'local' &&
			(event.key === null ||
				[FLASH_STORAGE_KEYS.day, FLASH_STORAGE_KEYS.total, FLASH_STORAGE_KEYS.lastWriteAt].some(
					(key) => key === event.key
				))
		) {
			refresh(true);
		}
	});
	return {
		get state() {
			return structuredClone(state);
		},
		get error() {
			return status.error;
		},
		canWriteNow(at = now()) {
			observe(at);
			return canWriteNow(state, at);
		},
		dailyNotice(at = now()) {
			return dailyNotice(state, at);
		},
		/**
		 * Counts one real write attempt that is about to reach the cable (called before its first
		 * byte, so a tab closed mid-write still counts it). Never for simulated writes.
		 */
		recordWrite(at = now()) {
			observe(at);
			state = recordWrite(state, at);
			const raw = serializeFlashState(state);
			storage.write('local', FLASH_STORAGE_KEYS.day, raw.day);
			storage.write('local', FLASH_STORAGE_KEYS.total, raw.total);
			storage.write('local', FLASH_STORAGE_KEYS.lastWriteAt, raw.lastWriteAt);
			storage.write('session', FLASH_STORAGE_KEYS.session, raw.session);
		},
		/**
		 * The cable was last touched at `at` (end of a write sequence): moves `lastWriteAt` forward
		 * so the 2 s spacing runs from the end of the write. Counters are not changed.
		 */
		touchWrite(at = now()) {
			observe(at);
			if (state.lastWriteAt !== null && state.lastWriteAt >= at) return;
			state = { ...state, lastWriteAt: at };
			storage.write(
				'local',
				FLASH_STORAGE_KEYS.lastWriteAt,
				serializeFlashState(state).lastWriteAt
			);
		},
		dispose() {
			stop();
			status.dispose();
			if (!options.storage) storage.dispose();
		}
	};
}
