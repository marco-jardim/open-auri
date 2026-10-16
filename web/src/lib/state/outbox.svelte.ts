import { isTimestamp } from './model.ts';
import type { Clock } from './model.ts';
import { createStorage, isRecord, type ClientStorage } from './storage.ts';
import { storageStatus } from './status.svelte.ts';

export type JsonValue =
	null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface PendingEvent {
	readonly id: string;
	readonly type: string;
	readonly payload: JsonValue;
	readonly createdAt: number;
	readonly updatedAt: number;
}

function isJson(value: unknown): value is JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (Array.isArray(value)) return Array.from(value).every(isJson);
	return (
		isRecord(value) &&
		(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
		Object.values(value).every(isJson)
	);
}

function checkedEvent(value: unknown): PendingEvent {
	if (
		!isRecord(value) ||
		typeof value.id !== 'string' ||
		!value.id ||
		typeof value.type !== 'string' ||
		!value.type ||
		!isJson(value.payload) ||
		!isTimestamp(value.createdAt) ||
		!isTimestamp(value.updatedAt) ||
		value.createdAt > value.updatedAt
	) {
		throw new TypeError('Invalid outbox event');
	}
	return {
		id: value.id,
		type: value.type,
		payload: structuredClone(value.payload),
		createdAt: value.createdAt,
		updatedAt: value.updatedAt
	};
}

export function createOutboxStore(
	options: { storage?: ClientStorage; now?: Clock; id?: () => string } = {}
) {
	const storage = options.storage ?? createStorage();
	const status = storageStatus(storage);
	const now = options.now ?? Date.now;
	const id = options.id ?? (() => globalThis.crypto.randomUUID());
	let events = $state.raw<readonly PendingEvent[]>([]);
	let loading = $state(true);
	let generation = 0;
	let disposed = false;
	function validate(values: Record<string, unknown>[]) {
		const valid: PendingEvent[] = [];
		for (const value of values) {
			try {
				valid.push(checkedEvent(value));
			} catch (cause) {
				storage.report(cause, 'outbox:load', true);
			}
		}
		return valid.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	}
	async function refresh() {
		const token = ++generation;
		const values = await storage.loadRecords('outbox');
		if (!disposed && token === generation) {
			events = validate(values);
			loading = false;
		}
	}
	const ready = refresh();
	const stop = storage.onDatabase((store) => {
		if (store === 'outbox') void refresh();
	});
	return {
		ready,
		get events() {
			return structuredClone(events);
		},
		get loading() {
			return loading;
		},
		get error() {
			return status.error;
		},
		refresh,
		async list() {
			await refresh();
			return structuredClone(events);
		},
		async append(input: { id?: string; type: string; payload: JsonValue; updatedAt?: number }) {
			let event: PendingEvent;
			try {
				const at = input.updatedAt ?? now();
				event = checkedEvent({ ...input, id: input.id ?? id(), createdAt: at, updatedAt: at });
			} catch (cause) {
				storage.report(cause, 'outbox:append', true);
				return null;
			}
			await ready;
			++generation;
			const values = await storage.updateRecords('outbox', (values) => {
				const previous = validate(values).find((value) => value.id === event.id);
				if (previous && previous.updatedAt >= event.updatedAt) {
					event = previous;
					return {};
				}
				event = { ...event, createdAt: previous?.createdAt ?? event.createdAt };
				return { put: [{ ...event }] };
			});
			if (!disposed) events = validate(values);
			return structuredClone(event);
		},
		async remove(eventId: string) {
			await ready;
			++generation;
			const values = await storage.updateRecords('outbox', () => ({ remove: [eventId] }));
			if (!disposed) events = validate(values);
		},
		dispose() {
			disposed = true;
			++generation;
			stop();
			status.dispose();
			if (!options.storage) storage.dispose();
		}
	};
}
