export interface LocalDataBackends {
	local: Pick<Storage, 'length' | 'key' | 'removeItem'>;
	session: Pick<Storage, 'length' | 'key' | 'removeItem'>;
	indexedDB: Pick<IDBFactory, 'deleteDatabase'>;
}

function removeOwnedKeys(storage: LocalDataBackends['local']) {
	// Includes oa.tour.v1 (guided-tour seen/dismissed states); never sent to the server.
	const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
	for (const key of keys) if (key?.startsWith('oa.')) storage.removeItem(key);
}

/** No fetch, cable, account, cookie or unrelated-origin storage operations. */
export async function clearLocalData(backends: LocalDataBackends): Promise<void> {
	removeOwnedKeys(backends.local);
	removeOwnedKeys(backends.session);
	await new Promise<void>((resolve, reject) => {
		const request = backends.indexedDB.deleteDatabase('open-auri');
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error ?? new Error('IndexedDB deletion failed'));
		request.onblocked = () => reject(new Error('IndexedDB deletion blocked by another tab'));
	});
}

/** The dialog result is the sole entry point. Cancellation never even reads browser storage. */
export async function confirmedClear(
	confirmed: boolean,
	getBackends: () => LocalDataBackends,
	prepare: () => void | Promise<void> = () => undefined
) {
	if (!confirmed) return false;
	await prepare();
	await clearLocalData(getBackends());
	return true;
}
