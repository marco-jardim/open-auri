import { mayApplyUpdate, SKIP_WAITING } from './strategy.ts';

declare global {
	interface Window {
		/** Cable service: set synchronously before any write; clear in finally after it settles. */
		__oaWriteInProgress?: boolean;
	}
}

export interface UpdateState {
	waiting: boolean;
	applying: boolean;
	blocked: boolean;
}

export interface PwaController {
	/** Call only from an explicit user action. Returns false while a cable write is in flight. */
	applyUpdate(): boolean;
	dispose(): void;
}

export interface RegisterOptions {
	workerUrl?: string;
	scope?: string;
	onState?: (state: UpdateState) => void;
}

export async function registerPwa({
	workerUrl = '/service-worker.js',
	scope = '/',
	onState = () => undefined
}: RegisterOptions = {}): Promise<PwaController> {
	if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !window.isSecureContext) {
		return { applyUpdate: () => false, dispose: () => undefined };
	}

	const workers = navigator.serviceWorker;
	const registration = await workers.register(workerUrl, {
		scope,
		type: 'module',
		updateViaCache: 'none'
	});
	let state: UpdateState = { waiting: false, applying: false, blocked: false };
	let requested = false;
	let reloadPending = false;
	let disposed = false;
	const observed = new Set<ServiceWorker>();
	function publish(next: Partial<UpdateState>) {
		state = { ...state, ...next };
		if (!disposed) onState(state);
	}
	function inspect() {
		publish({ waiting: reloadPending || Boolean(registration.waiting && workers.controller) });
	}
	function observe() {
		const installing = registration.installing;
		if (installing && !observed.has(installing)) {
			observed.add(installing);
			installing.addEventListener('statechange', inspect);
		}
		inspect();
	}
	function reloadIfSafe(): boolean {
		if (!mayApplyUpdate(window.__oaWriteInProgress)) {
			publish({ waiting: true, applying: false, blocked: true });
			return false;
		}
		window.location.reload();
		return true;
	}
	function controllerChanged() {
		// First installation and updates requested by other tabs must never reload this tab.
		if (!requested || disposed) return;
		reloadPending = true;
		// A write may have started after the click but before activation. Require another click
		// if that happened, rather than scheduling an automatic reload when the write completes.
		reloadIfSafe();
	}
	registration.addEventListener('updatefound', observe);
	workers.addEventListener('controllerchange', controllerChanged);
	observe();

	return {
		applyUpdate() {
			if (disposed) return false;
			if (!mayApplyUpdate(window.__oaWriteInProgress)) {
				publish({ blocked: true });
				return false;
			}
			if (reloadPending) return reloadIfSafe();
			const waiting = registration.waiting;
			if (!waiting || state.applying) return false;
			requested = true;
			publish({ applying: true, blocked: false });
			waiting.postMessage({ type: SKIP_WAITING });
			return true;
		},
		dispose() {
			disposed = true;
			registration.removeEventListener('updatefound', observe);
			workers.removeEventListener('controllerchange', controllerChanged);
			for (const worker of observed) worker.removeEventListener('statechange', inspect);
		}
	};
}
