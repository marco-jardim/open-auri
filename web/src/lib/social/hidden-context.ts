import { getContext, setContext } from 'svelte';
import { createSocialApi } from './api.ts';
import { createHiddenStore, type HiddenStore } from './hidden-store.ts';

export const HIDDEN_CONTEXT = Symbol('hidden items');
export function setHiddenStore(store = createHiddenStore(createSocialApi())): HiddenStore {
	return setContext(HIDDEN_CONTEXT, store);
}
export function getHiddenStore(): HiddenStore {
	const context = getContext<HiddenStore | undefined>(HIDDEN_CONTEXT);
	if (context) return context;
	// Isolated previews/tests have no layout provider and are anonymous.
	const store = createHiddenStore(createSocialApi());
	void store.setUser(null);
	return setHiddenStore(store);
}
