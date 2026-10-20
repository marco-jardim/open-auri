/**
 * `NativeHID`: the Android app's USB bridge (`OpenAuriUsb`, bridgeApi 1, plan Anexo B) behind
 * the WebHID surface the cable stack uses (`HidLike` of the service, `CableHID` and
 * `CableDevice` of `open-auri/transport`). The safety path is unchanged: the gate, the checklist
 * and `writeCurve`/`writeMany` run on top of it exactly as on desktop.
 *
 * WebHID semantics kept here:
 * - one object per connected device: the same `NativeHIDDevice` for a native key until it is
 *   unplugged; a reconnection gets a new key and a new object;
 * - `connect` fires only for devices the app may use (as WebHID fires only for permitted
 *   devices), `disconnect` for every device the page holds, before the rejection of any call
 *   pending on it (the plugin guarantees that order);
 * - `opened` is false until `open()` resolves and after `close()`, a disconnect or native
 *   session loss;
 *   `sendReport()` on a device that is not open rejects with `InvalidStateError` before any
 *   plugin call; `close()` of a device the plugin no longer knows resolves.
 *
 * Results of the plugin are validated before use (another program answers them). No
 * `@capacitor/core` import here: the plugin is injected (see `bridge.ts`, loaded on demand).
 */
import type { CableFilter } from '../types.ts';
import { NATIVE_HID_BRAND } from './brand.ts';
import { callNative, nativeError, nativeErrorCode } from './errors.ts';

/** A device as the plugin reports it (schema `NativeDeviceInfo`). */
export interface NativeDeviceInfo {
	/** `deviceName#n`: valid while the device stays attached; a reconnection yields a new key. */
	key: string;
	vendorId: number;
	productId: number;
	/** The USB product string; empty when the device has none. */
	productName: string;
}

/** Endpoint of the HID interface (schema `UsbDiagnostics.endpoints`). */
export interface UsbEndpoint {
	address: number;
	type: 'interrupt' | 'bulk' | 'control' | 'isochronous';
	direction: 'in' | 'out';
	maxPacketSize: number;
}

/** USB diagnostics of an open device (schema `UsbDiagnostics`, RF8). */
export interface UsbDiagnostics {
	device: NativeDeviceInfo;
	appVersion: string;
	androidVersion: string;
	webViewVersion: string;
	rawDescriptorsHex: string;
	hidInterfaceId: number;
	endpoints: UsbEndpoint[];
	reportDescriptorHex: string;
	outputReports: { reportId: number; bytes: number }[];
	transfer: 'interrupt' | 'control';
	paddedLength: number;
	kernelDriverDetached: boolean;
	/** Debug builds of the app only. */
	wireLog?: { atMs: number; hex: string }[];
}

/** `{vendorId, productId}` filter sent to the plugin (schema `UsbFilter`). */
export interface NativeUsbFilter {
	vendorId?: number;
	productId?: number;
}

export interface NativeKeyOptions {
	key: string;
}

export interface NativeSendReportOptions {
	key: string;
	reportId: number;
	/** Report data without the report ID, standard base64. */
	data: string;
}

export type NativeEventName = 'connect' | 'disconnect';

/**
 * Receives `{ device: NativeDeviceInfo }`; on a page outside the pinned origin Capacitor may
 * call it with `null` and an error. Typed `unknown`: `NativeHID` validates it.
 */
export type NativeEventListener = (event: unknown, error?: unknown) => void;

export interface NativeListenerHandle {
	remove(): Promise<void>;
}

/**
 * The `OpenAuriUsb` plugin as the page sees it. Rejections are `CapacitorException`s whose
 * `code` is a `NativeErrorCode`. Results are typed `unknown` on purpose: every one is checked
 * against the contract (schemas/android-usb-bridge-1.schema.json) before use.
 */
export interface OpenAuriUsbPlugin {
	/** `{ bridgeApi, appVersion, usbHost, webViewVersion }`. */
	getInfo(): Promise<unknown>;
	/** `{ devices: NativeDeviceInfo[] }`; empty when the user cancelled or denied. */
	requestDevice(options: { filters: NativeUsbFilter[] }): Promise<unknown>;
	/** `{ devices: NativeDeviceInfo[] }`: attached cables the app has permission for. */
	getDevices(): Promise<unknown>;
	open(options: NativeKeyOptions): Promise<unknown>;
	close(options: NativeKeyOptions): Promise<unknown>;
	sendReport(options: NativeSendReportOptions): Promise<unknown>;
	/** `UsbDiagnostics` of an open device. */
	diagnostics(options: NativeKeyOptions): Promise<unknown>;
	addListener(
		eventName: NativeEventName,
		listener: NativeEventListener
	): Promise<NativeListenerHandle>;
}

/** Report data as WebHID accepts it (`BufferSource`, any backing buffer). */
export type ReportData = ArrayBuffer | ArrayBufferView;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
	return typeof value === 'object' && value !== null;
}

function isUint(value: unknown, max: number): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

function isHex(value: unknown): value is string {
	return typeof value === 'string' && /^(?:[0-9a-f]{2})*$/.test(value);
}

function isText(value: unknown): value is string {
	return typeof value === 'string' && value !== '';
}

function arrayOf(value: unknown, item: (entry: unknown) => boolean): boolean {
	return Array.isArray(value) && value.every(item);
}

export function isNativeDeviceInfo(value: unknown): value is NativeDeviceInfo {
	return (
		isRecord(value) &&
		isText(value.key) &&
		isUint(value.vendorId, 0xffff) &&
		isUint(value.productId, 0xffff) &&
		typeof value.productName === 'string'
	);
}

const ENDPOINT_TYPES: readonly unknown[] = ['interrupt', 'bulk', 'control', 'isochronous'];

function isEndpoint(value: unknown): boolean {
	return (
		isRecord(value) &&
		isUint(value.address, 0xff) &&
		ENDPOINT_TYPES.includes(value.type) &&
		(value.direction === 'in' || value.direction === 'out') &&
		isUint(value.maxPacketSize, 0xffff)
	);
}

function isOutputReport(value: unknown): boolean {
	return isRecord(value) && isUint(value.reportId, 0xff) && isUint(value.bytes, 0xffff);
}

function isWireEntry(value: unknown): boolean {
	return isRecord(value) && isUint(value.atMs, Number.MAX_SAFE_INTEGER) && isHex(value.hex);
}

export function isUsbDiagnostics(value: unknown): value is UsbDiagnostics {
	return (
		isRecord(value) &&
		isNativeDeviceInfo(value.device) &&
		isText(value.appVersion) &&
		isText(value.androidVersion) &&
		isText(value.webViewVersion) &&
		isHex(value.rawDescriptorsHex) &&
		isUint(value.hidInterfaceId, 0xff) &&
		arrayOf(value.endpoints, isEndpoint) &&
		isHex(value.reportDescriptorHex) &&
		arrayOf(value.outputReports, isOutputReport) &&
		(value.transfer === 'interrupt' || value.transfer === 'control') &&
		isUint(value.paddedLength, 0x10000) &&
		typeof value.kernelDriverDetached === 'boolean' &&
		(value.wireLog === undefined || arrayOf(value.wireLog, isWireEntry))
	);
}

function deviceList(response: unknown): NativeDeviceInfo[] {
	if (!isRecord(response) || !Array.isArray(response.devices)) {
		throw new TypeError('OpenAuriUsb returned a malformed device list');
	}
	const entries: readonly unknown[] = response.devices;
	const devices: NativeDeviceInfo[] = [];
	for (const entry of entries) {
		if (!isNativeDeviceInfo(entry)) {
			throw new TypeError('OpenAuriUsb returned a malformed device');
		}
		devices.push(entry);
	}
	return devices;
}

/** Bytes of `data`, honouring the byte offset and length of a view; TypeError otherwise. */
function bytesOf(data: unknown): Uint8Array {
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (!ArrayBuffer.isView(data)) {
		throw new TypeError('data must be an ArrayBuffer or an ArrayBufferView');
	}
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** Standard base64 (RFC 4648, padded) of `bytes`. */
export function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/** Devices of this module that were unplugged (their key is no longer valid). */
const detached = new WeakSet<NativeHIDDevice>();

function disconnectedError(): DOMException {
	return new DOMException('The device was disconnected.', 'NotFoundError');
}

/** One cable behind the bridge; created by {@link NativeHID} only. */
export class NativeHIDDevice {
	readonly vendorId: number;
	readonly productId: number;
	readonly productName: string;
	readonly #plugin: OpenAuriUsbPlugin;
	readonly #key: string;
	#opened = false;

	constructor(plugin: OpenAuriUsbPlugin, info: NativeDeviceInfo) {
		this.#plugin = plugin;
		this.#key = info.key;
		this.vendorId = info.vendorId;
		this.productId = info.productId;
		this.productName = info.productName;
	}

	/** True once `open()` resolved, until close, disconnect or native session loss. */
	get opened(): boolean {
		return this.#opened && !detached.has(this);
	}

	/** Opens the device (idempotent on the native side). */
	async open(): Promise<void> {
		if (detached.has(this)) throw disconnectedError();
		await callNative(() => this.#plugin.open({ key: this.#key }));
		// Unplugged while the call was pending: the device is gone, whatever the plugin said.
		if (detached.has(this)) throw disconnectedError();
		this.#opened = true;
	}

	/** Closes the device. A device the plugin no longer knows (unplugged) counts as closed. */
	async close(): Promise<void> {
		if (!detached.has(this)) {
			try {
				await this.#plugin.close({ key: this.#key });
			} catch (cause) {
				if (nativeErrorCode(cause) !== 'USB_NOT_FOUND') throw nativeError(cause);
			}
		}
		this.#opened = false;
	}

	/**
	 * Sends one output report: `reportId` (0..255) and `data` without it, as WebHID's
	 * `sendReport`. Invalid arguments reject with a TypeError and a closed device with
	 * `InvalidStateError`, both without any plugin call.
	 */
	async sendReport(reportId: number, data: ReportData): Promise<void> {
		if (!isUint(reportId, 0xff)) throw new TypeError(`invalid report ID ${String(reportId)}`);
		const encoded = toBase64(bytesOf(data));
		if (!this.opened) {
			throw new DOMException('The device must be opened first.', 'InvalidStateError');
		}
		await this.#callSession(() =>
			this.#plugin.sendReport({ key: this.#key, reportId, data: encoded })
		);
	}

	/** USB diagnostics (RF8), opening the device first when needed, for the cable page. */
	async diagnostics(): Promise<UsbDiagnostics> {
		if (!this.opened) await this.open();
		const report = await this.#callSession(() => this.#plugin.diagnostics({ key: this.#key }));
		if (!isUsbDiagnostics(report)) {
			throw new TypeError('OpenAuriUsb returned malformed diagnostics');
		}
		return report;
	}

	/** Native may drop a session without a disconnect; let the next operation reopen it. */
	async #callSession<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (cause) {
			const code = nativeErrorCode(cause);
			if (code === 'USB_NOT_OPEN' || code === 'USB_PERMISSION_DENIED' || code === 'USB_DETACHED') {
				this.#opened = false;
			}
			throw nativeError(cause);
		}
	}
}

/** `connect` / `disconnect` event of {@link NativeHID}, like WebHID's `HIDConnectionEvent`. */
export class NativeHIDConnectionEvent extends Event {
	readonly device: NativeHIDDevice;

	constructor(type: NativeEventName, device: NativeHIDDevice) {
		super(type);
		this.device = device;
	}
}

const FILTER_FIELDS = ['vendorId', 'productId'] as const;

/** The `{vendorId, productId}` part of each filter (other WebHID members are not sent). */
function filtersOf(options: unknown): NativeUsbFilter[] {
	if (!isRecord(options) || !Array.isArray(options.filters)) {
		throw new TypeError("requestDevice: 'filters' is required");
	}
	const filters: readonly unknown[] = options.filters;
	return filters.map((filter) => {
		if (!isRecord(filter)) throw new TypeError('requestDevice: each filter must be an object');
		const picked: NativeUsbFilter = {};
		for (const field of FILTER_FIELDS) {
			const value = filter[field];
			if (value === undefined) continue;
			if (!isUint(value, 0xffff)) throw new TypeError(`requestDevice: invalid ${field}`);
			picked[field] = value;
		}
		return picked;
	});
}

/**
 * `navigator.hid` for the Android app. Satisfies the service's `HidLike` and the core's
 * `CableHID` as is. The plugin's `connect`/`disconnect` listeners are added once, on the first
 * `addEventListener`, `requestDevice` or `getDevices`; `dispose()` removes them.
 */
export class NativeHID extends EventTarget {
	readonly [NATIVE_HID_BRAND] = true;
	readonly #plugin: OpenAuriUsbPlugin;
	/** Live devices by native key: one object per connection. */
	readonly #devices = new Map<string, NativeHIDDevice>();
	/** Keys that were unplugged: a late answer naming one never yields a device. */
	readonly #gone = new Set<string>();
	readonly #handles: NativeListenerHandle[] = [];
	#listening = false;
	#disposed = false;

	/** Makes no plugin call: listeners are added on first use. */
	constructor(plugin: OpenAuriUsbPlugin) {
		super();
		this.#plugin = plugin;
	}

	/** Asks the user for the cable (the app's USB permission dialog), like WebHID. */
	async requestDevice(options: { filters: CableFilter[] }): Promise<NativeHIDDevice[]> {
		const filters = filtersOf(options);
		this.#listen();
		const devices = deviceList(await callNative(() => this.#plugin.requestDevice({ filters })));
		return this.#adopt(devices);
	}

	/** Attached cables the app already has permission for. */
	async getDevices(): Promise<NativeHIDDevice[]> {
		this.#listen();
		return this.#adopt(await this.#permitted());
	}

	override addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: AddEventListenerOptions | boolean
	): void {
		this.#listen();
		super.addEventListener(type, listener, options);
	}

	/**
	 * Removes the plugin listeners; later native events are ignored and no listener is added
	 * again. Devices already handed out keep working until unplugged.
	 */
	async dispose(): Promise<void> {
		this.#disposed = true;
		const handles = this.#handles.splice(0);
		await Promise.all(handles.map(release));
	}

	async #permitted(): Promise<NativeDeviceInfo[]> {
		return deviceList(await callNative(() => this.#plugin.getDevices()));
	}

	#adopt(devices: readonly NativeDeviceInfo[]): NativeHIDDevice[] {
		return devices.filter((info) => !this.#gone.has(info.key)).map((info) => this.#deviceFor(info));
	}

	#deviceFor(info: NativeDeviceInfo): NativeHIDDevice {
		const known = this.#devices.get(info.key);
		if (known !== undefined) return known;
		const device = new NativeHIDDevice(this.#plugin, info);
		this.#devices.set(info.key, device);
		return device;
	}

	#listen(): void {
		if (this.#listening || this.#disposed) return;
		this.#listening = true;
		this.#subscribe('connect', this.#onConnect);
		this.#subscribe('disconnect', this.#onDisconnect);
	}

	#subscribe(name: NativeEventName, listener: NativeEventListener): void {
		callNative(() => this.#plugin.addListener(name, listener)).then(
			(handle) => {
				if (this.#disposed) void release(handle);
				else this.#handles.push(handle);
			},
			(cause: unknown) => console.warn(`OpenAuriUsb: could not listen for '${name}'`, cause)
		);
	}

	#onConnect: NativeEventListener = (event, error) => {
		const info = eventDevice(event, error);
		if (info === null || this.#disposed) return;
		void this.#announce(info);
	};

	/** Dispatches `connect` once the plugin confirms the app may use the device. */
	async #announce(info: NativeDeviceInfo): Promise<void> {
		let permitted: NativeDeviceInfo[];
		try {
			permitted = await this.#permitted();
		} catch (cause) {
			console.warn('OpenAuriUsb: could not check a connected device', cause);
			return;
		}
		if (this.#disposed || this.#gone.has(info.key)) return;
		if (!permitted.some((candidate) => candidate.key === info.key)) return;
		this.dispatchEvent(new NativeHIDConnectionEvent('connect', this.#deviceFor(info)));
	}

	#onDisconnect: NativeEventListener = (event, error) => {
		const info = eventDevice(event, error);
		if (info === null || this.#disposed) return;
		this.#gone.add(info.key);
		const device = this.#devices.get(info.key);
		if (device === undefined) return;
		detached.add(device);
		this.dispatchEvent(new NativeHIDConnectionEvent('disconnect', device));
		this.#devices.delete(info.key);
	};
}

/** The device of a plugin event; null (with a warning) when the payload is not one. */
function eventDevice(event: unknown, error: unknown): NativeDeviceInfo | null {
	if (isRecord(event) && isNativeDeviceInfo(event.device)) return event.device;
	console.warn('OpenAuriUsb: ignored a malformed device event', error ?? event);
	return null;
}

async function release(handle: NativeListenerHandle): Promise<void> {
	try {
		await handle.remove();
	} catch (cause) {
		console.warn('OpenAuriUsb: could not remove a listener', cause);
	}
}
