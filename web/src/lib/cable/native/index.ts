/**
 * Web side of the Android app's native USB bridge (plan T2.1). Mount it with
 * `detectNativeCable()`; on `kind: 'native'` give `hid` to `createCableService({ hid })`.
 *
 * `bridge.ts` is deliberately not re-exported: it imports `@capacitor/core` and is loaded only
 * by `detectNativeCable()`, with a dynamic import, inside the Android app.
 */
export {
	HANDSHAKE_TIMEOUT_MS,
	SUPPORTED_BRIDGE_API,
	detectNativeCable,
	isNativeAndroid,
	isSupportedBridgeApi,
	type DetectNativeOptions,
	type NativeBridgeModule,
	type NativeCableDetection,
	type NativeCableKind
} from './detect.ts';
export {
	NativeHID,
	NativeHIDConnectionEvent,
	NativeHIDDevice,
	isNativeDeviceInfo,
	isUsbDiagnostics,
	toBase64,
	type NativeDeviceInfo,
	type NativeEventListener,
	type NativeEventName,
	type NativeKeyOptions,
	type NativeListenerHandle,
	type NativeSendReportOptions,
	type NativeUsbFilter,
	type OpenAuriUsbPlugin,
	type ReportData,
	type UsbDiagnostics,
	type UsbEndpoint
} from './hid.ts';
export {
	NATIVE_ERROR_CODES,
	NATIVE_ERROR_NAMES,
	UNKNOWN_NATIVE_ERROR_NAME,
	callNative,
	isNativeErrorCode,
	nativeError,
	nativeErrorCode,
	type MappedErrorName,
	type NativeErrorCode
} from './errors.ts';
