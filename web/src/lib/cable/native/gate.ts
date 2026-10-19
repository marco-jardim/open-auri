/**
 * The synchronous "are we inside the Android app" check, kept free of imports so the root layout
 * can call it without pulling the native cable modules into the desktop initial chunk.
 */

function currentWindow(): object | undefined {
	return typeof window === 'undefined' ? undefined : window;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/**
 * Whether the page runs in the Android app (`window.Capacitor` native, platform `android`).
 * Synchronous and cheap; never throws (a hostile `window.Capacitor` reads as "no").
 */
export function isNativeAndroid(win: object | undefined = currentWindow()): boolean {
	if (win === undefined) return false;
	try {
		const capacitor = 'Capacitor' in win ? win.Capacitor : undefined;
		if (!isRecord(capacitor)) return false;
		const { isNativePlatform, getPlatform } = capacitor;
		if (typeof isNativePlatform !== 'function') return false;
		if (isNativePlatform.call(capacitor) !== true) return false;
		return typeof getPlatform === 'function' && getPlatform.call(capacitor) === 'android';
	} catch (cause) {
		console.warn('window.Capacitor could not be read', cause);
		return false;
	}
}
