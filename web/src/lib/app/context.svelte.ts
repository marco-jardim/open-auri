import { getContext, setContext } from 'svelte';
import type { ClientApp, ClientAppOptions } from './client.svelte.ts';
import type { ToastStore } from '#lib/components/chrome/toast.ts';
import type { NativeCableDetection } from '#lib/cable/native/index.ts';
import { loadAppRuntime } from './runtime.ts';

const APP_CONTEXT = Symbol('open-auri app');
export const NATIVE_CABLE_CONTEXT = Symbol('open-auri native cable');

/** UI metadata only; the HID stays owned by the mounted cable service. One holder per layout. */
export type NativeCableStatus =
	| { kind: 'none' }
	| { kind: Exclude<NativeCableDetection['kind'], 'none'>; appVersion: string | null };

export function createNativeCableState() {
	let result = $state.raw<NativeCableStatus>({ kind: 'none' });
	return {
		get result() {
			return result;
		},
		set result(next: NativeCableStatus) {
			result = next;
		}
	};
}

export type NativeCableState = ReturnType<typeof createNativeCableState>;

export function setNativeCableState(): NativeCableState {
	return setContext(NATIVE_CABLE_CONTEXT, createNativeCableState());
}

export function getNativeCableState(): NativeCableState {
	return getContext<NativeCableState | undefined>(NATIVE_CABLE_CONTEXT) ?? createNativeCableState();
}

/** Synchronous initial-chunk gate: no native module is requested on desktop. */
export function isNativeAndroid(
	win: object | undefined = typeof window === 'undefined' ? undefined : window
): boolean {
	if (win === undefined) return false;
	try {
		const capacitor = 'Capacitor' in win ? win.Capacitor : undefined;
		if (typeof capacitor !== 'object' || capacitor === null) return false;
		const { isNativePlatform, getPlatform } = capacitor as Record<string, unknown>;
		if (typeof isNativePlatform !== 'function') return false;
		if (isNativePlatform.call(capacitor) !== true) return false;
		return typeof getPlatform === 'function' && getPlatform.call(capacitor) === 'android';
	} catch (cause) {
		console.warn('window.Capacitor could not be read', cause);
		return false;
	}
}

interface NativeMountOptions {
	isNative?: () => boolean;
	detect?: () => Promise<NativeCableDetection>;
}

async function loadNativeDetection(): Promise<NativeCableDetection> {
	try {
		const native = await import('#lib/cable/native/index.ts');
		return native.detectNativeCable();
	} catch (error) {
		// A missing/offline detection chunk is just as unusable as an outdated native bridge.
		console.warn('Native cable detection could not load', error);
		return { kind: 'native-outdated', appVersion: null };
	}
}

/** Not async: the desktop mount is called in this task, with exactly its original options. */
export function mountNativeCable<T>(
	mount: (options: ClientAppOptions) => Promise<T>,
	toasts: ToastStore,
	state: NativeCableState,
	{ isNative = isNativeAndroid, detect = loadNativeDetection }: NativeMountOptions = {}
): Promise<T> {
	if (!isNative()) return mount({ toasts });
	return detect().then((result) => {
		state.result =
			result.kind === 'none' ? result : { kind: result.kind, appVersion: result.appVersion };
		// The app's `liveApply` capability decides whether the native cable is live-capable (#72).
		return mount(
			result.kind === 'native'
				? { toasts, cable: { hid: result.hid, nativeLiveApply: result.liveApply } }
				: { toasts }
		);
	});
}

export type AppRuntimeStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Undoes what `prepare` wired (the social outbox bridge); called when the app is disposed. */
export type AppPrepareCleanup = () => void;

export interface AppMountOptions {
	/**
	 * Awaited after the app exists and before it is published as `client`: wiring that must be
	 * in place before any write can start (the layout attaches the social outbox bridge here, so
	 * no real `cable:written` event is ever missed while it is available). It may return a
	 * cleanup, run when that app is disposed (also when it is disposed before being published).
	 * A rejection disposes the app and fails the mount (the next `mount()` tries again), unless
	 * `optional` is set.
	 */
	prepare?: (client: ClientApp) => Promise<AppPrepareCleanup | void> | AppPrepareCleanup | void;
	/**
	 * FUX.Q N6: the wiring is not required for the app to work (social sync). A rejection is
	 * logged, reported to `onprepareerror`, and the app is published anyway, so the cable
	 * status and the rescue notice still render; the caller marks what it could not wire.
	 */
	optional?: boolean;
	onprepareerror?: (error: unknown) => void;
}

/**
 * One reactive holder per layout/request. SSR has no browser state or process-wide app.
 * FUX.2: the runtime is a dynamic chunk, so `mount()` is async; `client` stays null until it has
 * loaded (and in SSR), which every page already handles.
 */
export function createAppContext() {
	let client = $state.raw<ClientApp | null>(null);
	let status = $state<AppRuntimeStatus>('idle');
	let mounting: Promise<ClientApp | null> | undefined;
	// Bumped by dispose(): a mount still loading when the layout goes away publishes nothing.
	let generation = 0;
	/** Cleanup returned by the published app's `prepare`. */
	let prepared: AppPrepareCleanup | undefined;

	function runCleanup(cleanup: AppPrepareCleanup | undefined): void {
		if (!cleanup) return;
		try {
			cleanup();
		} catch (error) {
			console.error('App wiring could not be undone', error);
		}
	}

	async function create(
		options: ClientAppOptions,
		{ prepare, optional = false, onprepareerror }: AppMountOptions,
		ticket: number
	): Promise<ClientApp | null> {
		const { createClientApp } = await loadAppRuntime();
		if (ticket !== generation) return null;
		const created = createClientApp(options);
		let cleanup: AppPrepareCleanup | undefined;
		try {
			const result = await prepare?.(created);
			if (typeof result === 'function') cleanup = result;
		} catch (error) {
			if (!optional) {
				created.dispose();
				throw error;
			}
			// Non-blocking wiring: the app works without it (writes included); the caller marks
			// it unavailable and may wire it later.
			console.warn('App wiring failed; publishing the app without it', error);
			onprepareerror?.(error);
		}
		if (ticket !== generation) {
			// Disposed while prepare ran: undo its wiring too (the outbox bridge would leak).
			runCleanup(cleanup);
			created.dispose();
			return null;
		}
		prepared = cleanup;
		client = created;
		return created;
	}

	return {
		/** The browser app; null in SSR and until the runtime chunk has loaded. */
		get client() {
			return client;
		},
		/** Runtime chunk lifecycle, for skeletons and diagnostics (`data-runtime` on the layout). */
		get status() {
			return status;
		},
		/**
		 * Root-layout lifecycle only. No work on the server, even if called accidentally. Calls
		 * while loading share one promise; once mounted it resolves with the same app.
		 */
		mount(options: ClientAppOptions = {}, mountOptions: AppMountOptions = {}) {
			if (typeof window === 'undefined') return Promise.resolve(null);
			if (client) return Promise.resolve(client);
			if (mounting) return mounting;
			const ticket = generation;
			status = 'loading';
			const attempt = create(options, mountOptions, ticket).then(
				(created) => {
					if (ticket === generation) {
						mounting = undefined;
						status = created ? 'ready' : 'idle';
					}
					return created;
				},
				(error: unknown) => {
					if (ticket === generation) {
						mounting = undefined;
						status = 'error';
					}
					throw error;
				}
			);
			mounting = attempt;
			return attempt;
		},
		dispose() {
			generation += 1;
			mounting = undefined;
			status = 'idle';
			const cleanup = prepared;
			prepared = undefined;
			runCleanup(cleanup);
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
