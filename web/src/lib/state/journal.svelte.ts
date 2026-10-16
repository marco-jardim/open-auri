import { SvelteMap } from 'svelte/reactivity';
import { appendEntry, parseJournal, serializeJournal, JOURNAL_STORAGE_KEY } from 'open-auri/policy';
import { createStorage, type ClientStorage } from './storage.ts';
import { storageStatus } from './status.svelte.ts';

type Entry = ReturnType<typeof parseJournal>['entries'][number];

export function createJournalStore(options: { storage?: ClientStorage } = {}) {
	const storage = options.storage ?? createStorage();
	const status = storageStatus(storage);
	function load() {
		return parseJournal(storage.read('local', JOURNAL_STORAGE_KEY));
	}
	const initial = load();
	let entries = $state.raw<readonly Entry[]>(initial.entries);
	let dropped = $state(initial.dropped);
	function merge(left: readonly Entry[], right: readonly Entry[]) {
		const unique = new SvelteMap(
			[...left, ...right].map((entry) => [JSON.stringify(entry), entry])
		);
		return parseJournal(JSON.stringify([...unique.values()].sort((a, b) => a.at - b.at))).entries;
	}
	const stop = storage.onStorage((event) => {
		if (event.area !== 'local' || event.key !== JOURNAL_STORAGE_KEY) return;
		const incoming = parseJournal(event.newValue);
		dropped = incoming.dropped;
		entries = merge(entries, incoming.entries);
		const serialized = serializeJournal(entries);
		if (incoming.entries.length && serialized !== serializeJournal(incoming.entries)) {
			storage.write('local', JOURNAL_STORAGE_KEY, serialized);
		}
	});
	return {
		get entries() {
			return structuredClone(entries);
		},
		get dropped() {
			return dropped;
		},
		/**
		 * Newest entry with status `ok` (a curve that reached the cable), or null. Reactive and
		 * cross-tab like `entries`, without cloning the whole journal.
		 */
		get lastOk(): Entry | null {
			for (let index = entries.length - 1; index >= 0; index--) {
				const entry = entries[index];
				if (entry !== undefined && entry.status === 'ok') return structuredClone(entry);
			}
			return null;
		},
		get error() {
			return status.error;
		},
		append(entry: unknown) {
			try {
				entries = appendEntry(merge(entries, load().entries), entry);
				storage.write('local', JOURNAL_STORAGE_KEY, serializeJournal(entries));
				return true;
			} catch (cause) {
				storage.report(cause, 'journal:append', true);
				return false;
			}
		},
		dispose() {
			stop();
			status.dispose();
			if (!options.storage) storage.dispose();
		}
	};
}
