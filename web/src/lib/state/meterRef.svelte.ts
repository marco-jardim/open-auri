import { createStorage, type ClientStorage } from './storage.ts';
import { storageStatus } from './status.svelte.ts';

export type MeterReference = -18 | -20 | -14;
export const METER_REFERENCE_KEY = 'oa.meter.ref';

function parse(raw: string | null): MeterReference {
	return raw === '-20' ? -20 : raw === '-14' ? -14 : -18;
}

export function createMeterRefStore(options: { storage?: ClientStorage } = {}) {
	const storage = options.storage ?? createStorage();
	const status = storageStatus(storage);
	let value = $state<MeterReference>(parse(storage.read('local', METER_REFERENCE_KEY)));
	const stop = storage.onStorage((event) => {
		if (event.area === 'local' && (event.key === METER_REFERENCE_KEY || event.key === null)) {
			// Read the latest backend value, not a potentially delayed event's older scalar.
			storage.acceptExternal('local', METER_REFERENCE_KEY);
			value = parse(storage.read('local', METER_REFERENCE_KEY));
		}
	});
	return {
		get value() {
			return value;
		},
		get error() {
			return status.error;
		},
		set(next: MeterReference) {
			if (next !== -18 && next !== -20 && next !== -14) return false;
			value = next;
			storage.write('local', METER_REFERENCE_KEY, String(value));
			return true;
		},
		dispose() {
			stop();
			status.dispose();
			if (!options.storage) storage.dispose();
		}
	};
}
