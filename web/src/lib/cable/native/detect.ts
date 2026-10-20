/**
 * Detection of the Android app's native USB bridge (plan T2.1, 0.12.10, 0.19).
 *
 * A synchronous, cheap gate reads `window.Capacitor`, which the app's `native-bridge.js`
 * defines before any site code runs; only when it says "native Android" is `bridge.ts` (and with
 * it `@capacitor/core`) loaded, with a dynamic import, so desktop and mobile browsers never load
 * it. Any page can forge `window.Capacitor`: this is a UI hint, the real boundary is native
 * (pinned origin, OriginGuard, FrameGuard).
 *
 * After the handshake (`getInfo()`, bounded by a timeout), in this order:
 * - `bridgeApi` outside {@link SUPPORTED_BRIDGE_API}, a malformed answer, a failure or a timeout:
 *   `native-outdated`;
 * - the write policy refuses the app version: `native-write-disabled`, and no `NativeHID` is
 *   created, so no I/O call to the plugin is possible (0.12.10);
 * - no USB host on the phone: `native-no-usb-host`;
 * - otherwise `native`, with the `NativeHID` to give the cable service.
 *
 * In the app, before the handshake (so before any cable service exists), the offline last-good
 * record is kept only when it confirms this build; `native-write-disabled` forgets it, so a
 * page served later from the service worker cache cannot write offline on it.
 */
import { canWriteFromApp, type AndroidWritePolicy } from '../android-status.ts';
import { forgetNativeLastGood, reconcileNativeLastGood } from '../native-freshness.ts';
import { isNativeAndroid } from './gate.ts';
import { NativeHID, type OpenAuriUsbPlugin } from './hid.ts';

/** Inclusive range of `bridgeApi` versions this site speaks. */
export const SUPPORTED_BRIDGE_API = Object.freeze([1, 1] as const);

/** How long the handshake (loading the bridge and `getInfo()`) may take. */
export const HANDSHAKE_TIMEOUT_MS = 3000;

/** What `bridge.ts` exports and detection reads. */
export interface NativeBridgeModule {
	readonly OpenAuriUsb: OpenAuriUsbPlugin;
}

export type NativeCableDetection =
	| { kind: 'native'; hid: NativeHID; appVersion: string; webViewVersion: string }
	/** `appVersion` is null when the handshake failed, timed out or did not name a version. */
	| { kind: 'native-outdated'; appVersion: string | null }
	| { kind: 'native-write-disabled'; appVersion: string }
	| { kind: 'native-no-usb-host'; appVersion: string }
	| { kind: 'none' };

export type NativeCableKind = NativeCableDetection['kind'];

export interface DetectNativeOptions {
	/** The window to inspect; defaults to the global `window` (none outside a browser). */
	win?: object;
	/** Loads the bridge module; defaults to `import('./bridge.ts')`. */
	loadBridge?: () => Promise<NativeBridgeModule>;
	/** Write policy; defaults to `ANDROID_WRITE_POLICY`. */
	policy?: AndroidWritePolicy;
	/** Handshake timeout; defaults to {@link HANDSHAKE_TIMEOUT_MS}. */
	timeoutMs?: number;
}

export { isNativeAndroid };

function currentWindow(): object | undefined {
	return typeof window === 'undefined' ? undefined : window;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/** Whether this site speaks the bridge version `value`. */
export function isSupportedBridgeApi(value: unknown): boolean {
	const [min, max] = SUPPORTED_BRIDGE_API;
	return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

const loadDefaultBridge = (): Promise<NativeBridgeModule> => import('./bridge.ts');

/** The plugin and its `getInfo()` answer, wrapped: the plugin proxy is never awaited. */
interface Handshake {
	plugin: OpenAuriUsbPlugin;
	info: unknown;
}

async function handshake(loadBridge: () => Promise<NativeBridgeModule>): Promise<Handshake> {
	const bridge = await loadBridge();
	const plugin = bridge.OpenAuriUsb;
	const info: unknown = await plugin.getInfo();
	return { plugin, info };
}

function withTimeout<T>(pending: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
	});
	return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Detects the native bridge. Resolves `{ kind: 'none' }` outside the Android app without
 * loading anything; never rejects.
 */
export async function detectNativeCable(
	options: DetectNativeOptions = {}
): Promise<NativeCableDetection> {
	const { loadBridge = loadDefaultBridge, policy, timeoutMs = HANDSHAKE_TIMEOUT_MS } = options;
	const win = 'win' in options ? options.win : currentWindow();
	if (!isNativeAndroid(win)) return { kind: 'none' };
	// Page start in the app: a record from another build (older or newer) is dropped.
	reconcileNativeLastGood();

	let answer: Handshake;
	try {
		answer = await withTimeout(handshake(loadBridge), timeoutMs);
	} catch (cause) {
		console.warn('OpenAuriUsb handshake failed', cause);
		return { kind: 'native-outdated', appVersion: null };
	}

	const { plugin, info } = answer;
	const appVersion = isRecord(info) && typeof info.appVersion === 'string' ? info.appVersion : '';
	if (
		!isRecord(info) ||
		!isSupportedBridgeApi(info.bridgeApi) ||
		appVersion === '' ||
		typeof info.usbHost !== 'boolean' ||
		typeof info.webViewVersion !== 'string' ||
		info.webViewVersion === ''
	) {
		return { kind: 'native-outdated', appVersion: appVersion === '' ? null : appVersion };
	}
	if (!canWriteFromApp(appVersion, policy)) {
		// This deploy disables native writes for this app: no older page may write offline.
		forgetNativeLastGood();
		return { kind: 'native-write-disabled', appVersion };
	}
	if (!info.usbHost) return { kind: 'native-no-usb-host', appVersion };
	return {
		kind: 'native',
		hid: new NativeHID(plugin),
		appVersion,
		webViewVersion: info.webViewVersion
	};
}
