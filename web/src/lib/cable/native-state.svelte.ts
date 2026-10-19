import { getContext, setContext } from 'svelte';
import type { ClientAppOptions } from '#lib/app/client.svelte.ts';
import type { ToastStore } from '#lib/components/chrome/toast.ts';
import { isNativeAndroid } from './native/gate.ts';
import type { NativeCableDetection } from './native/index.ts';

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

interface NativeMountOptions {
	isNative?: () => boolean;
	detect?: () => Promise<NativeCableDetection>;
}

async function loadNativeDetection(): Promise<NativeCableDetection> {
	try {
		const native = await import('./native/index.ts');
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
		return mount(result.kind === 'native' ? { toasts, cable: { hid: result.hid } } : { toasts });
	});
}
