import { getContext, setContext } from 'svelte';
import { createClientApp, type ClientApp, type ClientAppOptions } from './client.svelte.ts';

const APP_CONTEXT = Symbol('open-auri app');

/** One reactive holder per layout/request. SSR has no browser state or process-wide app. */
export function createAppContext() {
	let client = $state.raw<ClientApp | null>(null);
	return {
		get client() {
			return client;
		},
		/** Root-layout lifecycle only. No work on the server, even if called accidentally. */
		mount(options: ClientAppOptions = {}) {
			if (typeof window === 'undefined') return null;
			return (client ??= createClientApp(options));
		},
		dispose() {
			client?.dispose();
			client = null;
		}
	};
}

export type AppContext = ReturnType<typeof createAppContext>;

/** Call during a provider component's initialization, before its children render. */
export function setAppContext(context: AppContext = createAppContext()): AppContext {
	return setContext(APP_CONTEXT, context);
}

/** Call during page/component initialization; read .client reactively (null in SSR). */
export function getAppContext(): AppContext {
	const context = getContext<AppContext | undefined>(APP_CONTEXT);
	if (!context) throw new Error('App context requires the root layout provider');
	return context;
}
