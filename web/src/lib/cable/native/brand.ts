/**
 * Import-free marker of the Android `NativeHID`, so the cable service can tell the native transport
 * apart without loading the native modules into the desktop chunks. Every `NativeHID` carries it;
 * a forged marker only adds the native-only write requirements, never removes one.
 */
export const NATIVE_HID_BRAND: unique symbol = Symbol.for('open-auri.native-hid');

export function isNativeHid(value: unknown): boolean {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as { [NATIVE_HID_BRAND]?: unknown })[NATIVE_HID_BRAND] === true
	);
}
