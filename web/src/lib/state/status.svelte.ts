import type { ClientStorage, StorageFailure } from './storage.ts';

export function storageStatus(storage: ClientStorage) {
	let error = $state.raw<StorageFailure | null>(storage.error);
	const dispose = storage.onError((value) => {
		error = value;
	});
	return {
		get error() {
			return error;
		},
		dispose
	};
}
