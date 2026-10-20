import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import {
	HID_REPORT_ID,
	NEUTRAL_BANDS,
	REPORT_SIZE,
	USB_PID,
	USB_VID,
	commitReport
} from 'open-auri/dsp';
import { createFakeClock, requestCable, writeCurve } from 'open-auri/transport';
import {
	NativeHID,
	NativeHIDConnectionEvent,
	NativeHIDDevice,
	toBase64,
	type NativeDeviceInfo,
	type NativeEventListener,
	type NativeEventName,
	type NativeListenerHandle,
	type NativeSendReportOptions,
	type OpenAuriUsbPlugin,
	type UsbDiagnostics
} from '#lib/cable/native/hid.ts';
import type { CableDevice, HidLike, WriteOptions } from '#lib/cable/types.ts';

// --- Contract: every fake answer, event, rejection and request is checked against the schema ---

const SCHEMA_ID = 'https://open-auri.com/schemas/android-usb-bridge-1.schema.json';
const SCHEMA_URL = new URL('../../../../schemas/android-usb-bridge-1.schema.json', import.meta.url);
const ajv = new Ajv2020({ allErrors: true });
ajv.addSchema(JSON.parse(readFileSync(SCHEMA_URL, 'utf8')));

function violation(definition: string, value: unknown): string | null {
	const validate = ajv.getSchema(`${SCHEMA_ID}#/$defs/${definition}`);
	if (validate === undefined) return `missing $defs/${definition}`;
	return validate(value) ? null : `${definition}: ${ajv.errorsText(validate.errors)}`;
}

/** What Capacitor rejects with: an Error with the native `code`. */
class CapacitorError extends Error {
	readonly code: string;

	constructor(code: string, message = `native call failed: ${code}`) {
		super(message);
		this.code = code;
	}
}

type Method =
	'getInfo' | 'requestDevice' | 'getDevices' | 'open' | 'close' | 'sendReport' | 'diagnostics';

const DEFINITION: Record<Method, string> = {
	getInfo: 'GetInfo',
	requestDevice: 'RequestDevice',
	getDevices: 'GetDevices',
	open: 'Open',
	close: 'Close',
	sendReport: 'SendReport',
	diagnostics: 'Diagnostics'
};

const CABLE_A: NativeDeviceInfo = {
	key: '/dev/bus/usb/001/002#1',
	vendorId: USB_VID,
	productId: USB_PID,
	productName: 'USB DSP Audio'
};
/** The same cable plugged in again: a new key. */
const CABLE_A_AGAIN: NativeDeviceInfo = { ...CABLE_A, key: '/dev/bus/usb/001/003#2' };
const CABLE_B: NativeDeviceInfo = { ...CABLE_A, key: '/dev/bus/usb/002/002#3', productName: '' };

const DIAGNOSTICS: UsbDiagnostics = {
	device: CABLE_A,
	appVersion: '1.0.0',
	androidVersion: '15',
	webViewVersion: '141.0.7390.122',
	rawDescriptorsHex: '1201000200000040023302890100010203',
	hidInterfaceId: 3,
	endpoints: [
		{ address: 0x84, type: 'interrupt', direction: 'in', maxPacketSize: 64 },
		{ address: 0x05, type: 'interrupt', direction: 'out', maxPacketSize: 64 }
	],
	reportDescriptorHex: '0600ff0901a10185cb',
	outputReports: [{ reportId: 0xcb, bytes: 31 }],
	transfer: 'interrupt',
	paddedLength: 32,
	kernelDriverDetached: true
};
const DIAGNOSTICS_DEBUG: UsbDiagnostics = {
	...DIAGNOSTICS,
	wireLog: [{ atMs: 1200, hex: 'cb5aa5' }]
};

/** A fake `OpenAuriUsb`: attached devices, permissions, recorded calls, schema checks. */
class FakeUsb {
	readonly attached = new Map<string, NativeDeviceInfo>();
	readonly permitted = new Set<string>();
	readonly opened = new Set<string>();
	readonly calls: { method: Method; options: unknown }[] = [];
	readonly sends: NativeSendReportOptions[] = [];
	readonly violations: string[] = [];
	readonly listeners: Record<NativeEventName, Set<NativeEventListener>> = {
		connect: new Set(),
		disconnect: new Set()
	};
	readonly removed: NativeEventName[] = [];
	/** Replaces a method's answer (return a value or a promise, or throw). */
	readonly overrides = new Map<Method, (options: unknown) => unknown>();
	/** Methods whose answers are deliberately outside the contract (not checked). */
	readonly lenient = new Set<Method>();
	readonly addListener = vi.fn(
		async (name: NativeEventName, listener: NativeEventListener): Promise<NativeListenerHandle> => {
			this.listeners[name].add(listener);
			return {
				remove: async () => {
					this.listeners[name].delete(listener);
					this.removed.push(name);
				}
			};
		}
	);
	readonly plugin: OpenAuriUsbPlugin = {
		getInfo: () => this.invoke('getInfo', undefined),
		requestDevice: (options) => this.invoke('requestDevice', options),
		getDevices: () => this.invoke('getDevices', undefined),
		open: (options) => this.invoke('open', options),
		close: (options) => this.invoke('close', options),
		sendReport: (options) => {
			this.sends.push(options);
			return this.invoke('sendReport', options);
		},
		diagnostics: (options) => this.invoke('diagnostics', options),
		addListener: (name, listener) => this.addListener(name, listener)
	};

	plug(info: NativeDeviceInfo, permitted = true): void {
		this.attached.set(info.key, info);
		if (permitted) this.permitted.add(info.key);
	}

	/** Unplugs and fires `disconnect` (before any pending call is rejected, as the plugin does). */
	unplug(info: NativeDeviceInfo): void {
		this.attached.delete(info.key);
		this.permitted.delete(info.key);
		this.opened.delete(info.key);
		this.emit('disconnect', { device: info });
	}

	emit(name: NativeEventName, payload: unknown): void {
		this.check(name === 'connect' ? 'ConnectEvent' : 'DisconnectEvent', payload);
		this.emitRaw(name, payload);
	}

	emitRaw(name: NativeEventName, payload: unknown, error?: unknown): void {
		for (const listener of [...this.listeners[name]]) listener(payload, error);
	}

	callsOf(method: Method): unknown[] {
		return this.calls.filter((call) => call.method === method).map((call) => call.options);
	}

	check(definition: string, value: unknown): void {
		const problem = violation(definition, value);
		if (problem !== null) this.violations.push(problem);
	}

	private async invoke(method: Method, options: unknown): Promise<unknown> {
		this.calls.push({ method, options });
		this.check(`${DEFINITION[method]}Request`, options ?? {});
		const lenient = this.lenient.has(method);
		try {
			const value = await this.answer(method, options);
			if (!lenient) this.check(`${DEFINITION[method]}Response`, value ?? null);
			return value;
		} catch (error) {
			if (!lenient) {
				const payload =
					error instanceof CapacitorError ? { code: error.code, message: error.message } : error;
				this.check('Error', payload);
			}
			throw error;
		}
	}

	private async answer(method: Method, options: unknown): Promise<unknown> {
		const override = this.overrides.get(method);
		if (override !== undefined) return override(options);
		if (method === 'requestDevice') {
			for (const key of this.attached.keys()) this.permitted.add(key);
			return { devices: [...this.attached.values()] };
		}
		if (method === 'getDevices') {
			return { devices: [...this.attached.values()].filter((d) => this.permitted.has(d.key)) };
		}
		const key =
			typeof options === 'object' && options !== null && 'key' in options
				? String(options.key)
				: '';
		if (method === 'open') {
			if (!this.permitted.has(key)) throw new CapacitorError('USB_PERMISSION_DENIED');
			this.opened.add(key);
		}
		if (method === 'close') this.opened.delete(key);
		if (method === 'sendReport' || method === 'diagnostics') {
			if (!this.opened.has(key)) throw new CapacitorError('USB_NOT_OPEN');
			if (!this.permitted.has(key)) {
				this.opened.delete(key);
				throw new CapacitorError('USB_PERMISSION_DENIED');
			}
			if (method === 'diagnostics') return DIAGNOSTICS;
		}
		return undefined;
	}
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Lets pending promise chains and zero-delay timers run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function decode(base64: string): number[] {
	return Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function range(from: number, to: number): number[] {
	return Array.from({ length: to - from }, (_, index) => from + index);
}

let fake: FakeUsb;
let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
	fake = new FakeUsb();
	warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
	expect(fake.violations).toEqual([]);
	vi.restoreAllMocks();
});

async function openCable(info: NativeDeviceInfo = CABLE_A) {
	fake.plug(info);
	const hid = new NativeHID(fake.plugin);
	const [device] = await hid.requestDevice({
		filters: [{ vendorId: USB_VID, productId: USB_PID }]
	});
	if (device === undefined) throw new Error('no device granted');
	await device.open();
	return { hid, device };
}

describe('types', () => {
	test('NativeHID is the HidLike of the service and the CableHID of the core, without casts', async () => {
		const hid = new NativeHID(fake.plugin);
		const web: HidLike = hid;
		const core: NonNullable<WriteOptions['hid']> = hid;
		fake.plug(CABLE_A);
		const devices: CableDevice[] = await web.requestDevice({ filters: [] });
		expect(core).toBe(hid);
		expect(devices[0]).toBeInstanceOf(NativeHIDDevice);
	});
});

describe('NativeHID listeners', () => {
	test('the constructor makes no plugin call; native listeners are added once, on first use', async () => {
		const hid = new NativeHID(fake.plugin);
		expect(fake.calls).toEqual([]);
		expect(fake.addListener).not.toHaveBeenCalled();
		hid.addEventListener('disconnect', () => undefined);
		hid.addEventListener('connect', () => undefined);
		await hid.getDevices();
		await hid.requestDevice({ filters: [] });
		expect(fake.addListener.mock.calls.map(([name]) => name)).toEqual(['connect', 'disconnect']);
	});

	test('requestDevice and getDevices also start listening', async () => {
		const first = new NativeHID(fake.plugin);
		await first.requestDevice({ filters: [] });
		expect(fake.addListener).toHaveBeenCalledTimes(2);
		const second = new NativeHID(fake.plugin);
		await second.getDevices();
		expect(fake.addListener).toHaveBeenCalledTimes(4);
	});

	test('dispose removes the native listeners; later events and listeners are ignored', async () => {
		fake.plug(CABLE_A);
		const hid = new NativeHID(fake.plugin);
		const [device] = await hid.requestDevice({ filters: [] });
		const events: string[] = [];
		hid.addEventListener('disconnect', (event) => events.push(event.type));
		hid.addEventListener('connect', (event) => events.push(event.type));
		await flush();
		const [onConnect] = fake.listeners.connect;
		const [onDisconnect] = fake.listeners.disconnect;
		await hid.dispose();
		expect(fake.removed.sort()).toEqual(['connect', 'disconnect']);
		onDisconnect?.({ device: CABLE_A });
		onConnect?.({ device: CABLE_B });
		await flush();
		expect(events).toEqual([]);
		expect(fake.callsOf('getDevices')).toEqual([]);
		// The late disconnect was ignored: the device was not marked as unplugged.
		await device?.open();
		expect(device?.opened).toBe(true);
		hid.addEventListener('disconnect', () => undefined);
		expect(fake.addListener).toHaveBeenCalledTimes(2);
	});

	test('a NativeHID disposed before use never adds native listeners', async () => {
		const hid = new NativeHID(fake.plugin);
		await hid.dispose();
		hid.addEventListener('connect', () => undefined);
		await hid.getDevices();
		expect(fake.addListener).not.toHaveBeenCalled();
		expect(fake.callsOf('getDevices')).toHaveLength(1);
	});

	test('a registration that completes after dispose is removed at once', async () => {
		const pending = deferred<NativeListenerHandle>();
		const remove = vi.fn(async () => undefined);
		fake.addListener.mockImplementation(() => pending.promise);
		const hid = new NativeHID(fake.plugin);
		hid.addEventListener('connect', () => undefined);
		await hid.dispose();
		pending.resolve({ remove });
		await flush();
		expect(remove).toHaveBeenCalledTimes(2);
	});

	test('failures to add or remove a native listener are reported, never thrown', async () => {
		const hid = new NativeHID(fake.plugin);
		fake.addListener.mockImplementationOnce(async () => {
			throw new CapacitorError('USB_ORIGIN', 'foreign origin');
		});
		fake.addListener.mockImplementationOnce(async () => ({
			remove: async () => {
				throw new Error('bridge gone');
			}
		}));
		hid.addEventListener('connect', () => undefined);
		await flush();
		expect(warn).toHaveBeenCalledWith(
			"OpenAuriUsb: could not listen for 'connect'",
			expect.objectContaining({ name: 'SecurityError' })
		);
		await expect(hid.dispose()).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledWith(
			'OpenAuriUsb: could not remove a listener',
			expect.objectContaining({ message: 'bridge gone' })
		);
	});

	test('malformed or null events (foreign origin) are ignored with a warning', async () => {
		const hid = new NativeHID(fake.plugin);
		const events: string[] = [];
		hid.addEventListener('connect', (event) => events.push(event.type));
		hid.addEventListener('disconnect', (event) => events.push(event.type));
		await flush();
		const origin = new CapacitorError('USB_ORIGIN', 'page outside the pinned origin');
		fake.emitRaw('disconnect', null, origin);
		fake.emitRaw('connect', { device: { key: CABLE_A.key } });
		fake.emitRaw('connect', { device: { ...CABLE_A, vendorId: 0x10000 } });
		await flush();
		expect(events).toEqual([]);
		expect(fake.calls).toEqual([]);
		expect(warn).toHaveBeenCalledWith('OpenAuriUsb: ignored a malformed device event', origin);
		expect(warn).toHaveBeenCalledWith('OpenAuriUsb: ignored a malformed device event', {
			device: { key: CABLE_A.key }
		});
	});
});

describe('device identity', () => {
	test('one object per native key across requestDevice, getDevices and connect', async () => {
		fake.plug(CABLE_A);
		fake.plug(CABLE_B);
		const hid = new NativeHID(fake.plugin);
		const granted = await hid.requestDevice({ filters: [{ vendorId: USB_VID }] });
		const again = await hid.requestDevice({ filters: [{ productId: USB_PID }] });
		const permitted = await hid.getDevices();
		expect(granted).toHaveLength(2);
		expect(again[0]).toBe(granted[0]);
		expect(again[1]).toBe(granted[1]);
		expect(permitted).toEqual(granted);
		expect(permitted[0]).toBe(granted[0]);
		expect(granted[0]).toMatchObject({
			vendorId: USB_VID,
			productId: USB_PID,
			productName: 'USB DSP Audio',
			opened: false
		});
		expect(granted[1]?.productName).toBe('');
	});

	test('disconnect: closed device, the same object in the event, then a reconnect is a new object', async () => {
		const { hid, device } = await openCable();
		expect(device.opened).toBe(true);
		const seen: { device: NativeHIDDevice; opened: boolean; type: string }[] = [];
		const record = (event: Event) => {
			if (event instanceof NativeHIDConnectionEvent) {
				seen.push({ device: event.device, opened: event.device.opened, type: event.type });
			}
		};
		hid.addEventListener('disconnect', record);
		hid.addEventListener('connect', record);
		await flush();

		fake.unplug(CABLE_A);
		expect(seen).toEqual([{ device, opened: false, type: 'disconnect' }]);
		expect(device.opened).toBe(false);
		expect(await hid.getDevices()).toEqual([]);

		fake.plug(CABLE_A_AGAIN);
		fake.emit('connect', { device: CABLE_A_AGAIN });
		await flush();
		expect(seen).toHaveLength(2);
		const reconnected = seen[1]?.device;
		expect(seen[1]?.type).toBe('connect');
		expect(reconnected).toBeInstanceOf(NativeHIDDevice);
		expect(reconnected).not.toBe(device);
		expect(reconnected?.opened).toBe(false);
		expect(await hid.getDevices()).toEqual([reconnected]);
		expect((await hid.getDevices())[0]).toBe(reconnected);
	});

	test('connect fires only for devices the app may use (as WebHID, permitted devices only)', async () => {
		const hid = new NativeHID(fake.plugin);
		const connected: NativeHIDDevice[] = [];
		hid.addEventListener('connect', (event) => {
			if (event instanceof NativeHIDConnectionEvent) connected.push(event.device);
		});
		await flush();
		fake.plug(CABLE_B, false);
		fake.emit('connect', { device: CABLE_B });
		await flush();
		expect(connected).toEqual([]);
		expect(fake.callsOf('getDevices')).toHaveLength(1);

		const [granted] = await hid.requestDevice({ filters: [] });
		fake.emit('connect', { device: CABLE_B });
		await flush();
		expect(connected).toEqual([granted]);
		expect(connected[0]).toBe(granted);
	});

	test('connect is not dispatched when the device leaves, the check fails or the hid is disposed meanwhile', async () => {
		const hid = new NativeHID(fake.plugin);
		const connected: Event[] = [];
		hid.addEventListener('connect', (event) => connected.push(event));
		await flush();

		const left = deferred<unknown>();
		fake.overrides.set('getDevices', () => left.promise);
		fake.plug(CABLE_A);
		fake.emit('connect', { device: CABLE_A });
		fake.unplug(CABLE_A);
		left.resolve({ devices: [CABLE_A] });
		await flush();

		fake.overrides.set('getDevices', () => {
			throw new CapacitorError('USB_TRANSFER_FAILED', 'binder died');
		});
		fake.plug(CABLE_B);
		fake.emit('connect', { device: CABLE_B });
		await flush();
		expect(warn).toHaveBeenCalledWith(
			'OpenAuriUsb: could not check a connected device',
			expect.objectContaining({ name: 'NotAllowedError' })
		);

		const late = deferred<unknown>();
		fake.overrides.set('getDevices', () => late.promise);
		fake.emit('connect', { device: CABLE_B });
		await hid.dispose();
		late.resolve({ devices: [CABLE_B] });
		await flush();
		expect(connected).toEqual([]);
	});

	test('a disconnect of a device the page never held dispatches nothing, and its key never comes back', async () => {
		const hid = new NativeHID(fake.plugin);
		const events: Event[] = [];
		hid.addEventListener('disconnect', (event) => events.push(event));
		await flush();
		fake.unplug(CABLE_A);
		expect(events).toEqual([]);
		// A late answer naming the unplugged key yields no device.
		fake.overrides.set('requestDevice', () => ({ devices: [CABLE_A, CABLE_B] }));
		const devices = await hid.requestDevice({ filters: [] });
		expect(devices).toHaveLength(1);
		expect(devices[0]?.productName).toBe('');
	});
});

describe('requestDevice and getDevices', () => {
	test('sends only vendorId and productId of each filter', async () => {
		const hid = new NativeHID(fake.plugin);
		const filters = [{ vendorId: USB_VID, productId: USB_PID, usagePage: 0xff00 }, {}];
		await hid.requestDevice({ filters });
		expect(fake.callsOf('requestDevice')).toEqual([
			{ filters: [{ vendorId: USB_VID, productId: USB_PID }, {}] }
		]);
	});

	test('invalid options are a TypeError before any plugin call', async () => {
		const hid = new NativeHID(fake.plugin);
		const call = (options: unknown) => Reflect.apply(hid.requestDevice, hid, [options]);
		await expect(call(undefined)).rejects.toThrow(TypeError);
		await expect(call({})).rejects.toThrow("requestDevice: 'filters' is required");
		await expect(call({ filters: [null] })).rejects.toThrow('each filter must be an object');
		await expect(call({ filters: [{ vendorId: -1 }] })).rejects.toThrow('invalid vendorId');
		await expect(call({ filters: [{ productId: 0x10000 }] })).rejects.toThrow('invalid productId');
		await expect(call({ filters: [{ vendorId: '0x3302' }] })).rejects.toThrow(TypeError);
		expect(fake.calls).toEqual([]);
	});

	test('cancel or denial resolves with no device', async () => {
		const hid = new NativeHID(fake.plugin);
		await expect(hid.requestDevice({ filters: [] })).resolves.toEqual([]);
	});

	test('native rejections are mapped (USB_NO_HOST is NotSupportedError)', async () => {
		const hid = new NativeHID(fake.plugin);
		fake.overrides.set('requestDevice', () => {
			throw new CapacitorError('USB_NO_HOST', 'no USB host');
		});
		await expect(hid.requestDevice({ filters: [] })).rejects.toMatchObject({
			name: 'NotSupportedError',
			message: 'no USB host (USB_NO_HOST)'
		});
	});

	test('a malformed device list is a TypeError', async () => {
		const hid = new NativeHID(fake.plugin);
		fake.lenient.add('requestDevice').add('getDevices');
		fake.overrides.set('requestDevice', () => ({ devices: 'none' }));
		await expect(hid.requestDevice({ filters: [] })).rejects.toThrow('malformed device list');
		fake.overrides.set('requestDevice', () => ({ devices: [{ key: CABLE_A.key }] }));
		await expect(hid.requestDevice({ filters: [] })).rejects.toThrow('malformed device');
		fake.overrides.set('getDevices', () => null);
		await expect(hid.getDevices()).rejects.toBeInstanceOf(TypeError);
	});
});

describe('NativeHIDDevice open and close', () => {
	test('opened is false until open() resolves', async () => {
		fake.plug(CABLE_A);
		const hid = new NativeHID(fake.plugin);
		const [device] = await hid.requestDevice({ filters: [] });
		if (device === undefined) throw new Error('no device');
		const pending = deferred<unknown>();
		fake.overrides.set('open', () => pending.promise);
		const opening = device.open();
		await flush();
		expect(device.opened).toBe(false);
		pending.resolve(undefined);
		await opening;
		expect(device.opened).toBe(true);
		expect(fake.callsOf('open')).toEqual([{ key: CABLE_A.key }]);
		fake.overrides.delete('open');
		await device.open();
		expect(device.opened).toBe(true);
	});

	test.each([
		['USB_PERMISSION_DENIED', 'NotAllowedError'],
		['USB_NOT_FOUND', 'NotFoundError'],
		['USB_TRANSFER_FAILED', 'NotAllowedError'],
		['USB_DETACHED', 'NotAllowedError'],
		['USB_BAD_ARGS', 'TypeError']
	])('open() rejected with %s is %s and leaves the device closed', async (code, name) => {
		fake.plug(CABLE_A);
		const hid = new NativeHID(fake.plugin);
		const [device] = await hid.requestDevice({ filters: [] });
		fake.overrides.set('open', () => {
			throw new CapacitorError(code, 'open failed');
		});
		await expect(device?.open()).rejects.toMatchObject({ name });
		expect(device?.opened).toBe(false);
	});

	test('open() of an unplugged device is NotFoundError without a plugin call', async () => {
		const { device } = await openCable();
		fake.unplug(CABLE_A);
		await flush();
		const before = fake.callsOf('open').length;
		await expect(device.open()).rejects.toMatchObject({ name: 'NotFoundError' });
		expect(fake.callsOf('open')).toHaveLength(before);
	});

	test('a device unplugged while open() is pending stays closed', async () => {
		fake.plug(CABLE_A);
		const hid = new NativeHID(fake.plugin);
		const [device] = await hid.requestDevice({ filters: [] });
		await flush();
		const pending = deferred<unknown>();
		fake.overrides.set('open', () => pending.promise);
		const opening = device?.open();
		await flush();
		fake.unplug(CABLE_A);
		pending.resolve(undefined);
		await expect(opening).rejects.toMatchObject({ name: 'NotFoundError' });
		expect(device?.opened).toBe(false);
	});

	test('close() closes; an unknown key (USB_NOT_FOUND) counts as closed', async () => {
		const { device } = await openCable();
		await device.close();
		expect(device.opened).toBe(false);
		expect(fake.callsOf('close')).toEqual([{ key: CABLE_A.key }]);
		await device.open();
		fake.overrides.set('close', () => {
			throw new CapacitorError('USB_NOT_FOUND', 'unknown key');
		});
		await expect(device.close()).resolves.toBeUndefined();
		expect(device.opened).toBe(false);
	});

	test('close() of an unplugged device resolves without a plugin call', async () => {
		const { device } = await openCable();
		fake.unplug(CABLE_A);
		await expect(device.close()).resolves.toBeUndefined();
		expect(fake.callsOf('close')).toEqual([]);
	});

	test('other close() failures are mapped and thrown, the device stays open', async () => {
		const { device } = await openCable();
		fake.overrides.set('close', () => {
			throw new CapacitorError('USB_BUSY', 'a write is in progress');
		});
		await expect(device.close()).rejects.toMatchObject({
			name: 'InvalidStateError',
			message: 'a write is in progress (USB_BUSY)'
		});
		expect(device.opened).toBe(true);
	});
});

describe('NativeHIDDevice sendReport', () => {
	test.each([0, 31, 32])('%i bytes are sent as base64 with the report ID', async (length) => {
		const { device } = await openCable();
		const data = Uint8Array.from(range(0, length), (byte) => (byte * 37 + 11) & 0xff);
		await device.sendReport(HID_REPORT_ID, data);
		expect(fake.sends).toHaveLength(1);
		expect(fake.sends[0]?.key).toBe(CABLE_A.key);
		expect(fake.sends[0]?.reportId).toBe(HID_REPORT_ID);
		expect(decode(fake.sends[0]?.data ?? 'x')).toEqual([...data]);
		if (length === 0) expect(fake.sends[0]?.data).toBe('');
	});

	test('views respect byteOffset and byteLength; ArrayBuffer is sent whole', async () => {
		const { device } = await openCable();
		const buffer = new ArrayBuffer(64);
		new Uint8Array(buffer).set(range(0, 64));
		await device.sendReport(0xcb, new Uint8Array(buffer, 7, 31));
		await device.sendReport(0xcb, new DataView(buffer, 5, 32));
		await device.sendReport(0xcb, new Uint16Array(buffer, 2, 4));
		await device.sendReport(0xcb, new Uint8Array(buffer).subarray(33, 64));
		await device.sendReport(0xcb, buffer.slice(1, 32));
		expect(fake.sends.map((sent) => decode(sent.data))).toEqual([
			range(7, 38),
			range(5, 37),
			range(2, 10),
			range(33, 64),
			range(1, 32)
		]);
	});

	test('toBase64 is standard, padded base64', () => {
		expect(toBase64(Uint8Array.of(0xcb, 0x00, 0xff))).toBe('ywD/');
		expect(toBase64(Uint8Array.of(0xfb, 0xff))).toBe('+/8=');
		expect(toBase64(new Uint8Array(0))).toBe('');
	});

	test('an invalid report ID or data is a TypeError without a plugin call', async () => {
		const { device } = await openCable();
		const send = (reportId: unknown, data: unknown) =>
			Reflect.apply(device.sendReport, device, [reportId, data]);
		for (const reportId of [-1, 256, 1.5, Number.NaN, '203']) {
			await expect(send(reportId, new Uint8Array(31))).rejects.toThrow(TypeError);
		}
		for (const data of ['abc', null, [1, 2, 3], undefined]) {
			await expect(send(0xcb, data)).rejects.toThrow(
				'data must be an ArrayBuffer or an ArrayBufferView'
			);
		}
		expect(fake.sends).toEqual([]);
	});

	test('a device that is not open is InvalidStateError without a plugin call', async () => {
		fake.plug(CABLE_A);
		const hid = new NativeHID(fake.plugin);
		const [device] = await hid.requestDevice({ filters: [] });
		await expect(device?.sendReport(0xcb, new Uint8Array(31))).rejects.toMatchObject({
			name: 'InvalidStateError'
		});
		await device?.open();
		await device?.close();
		await expect(device?.sendReport(0xcb, new Uint8Array(31))).rejects.toMatchObject({
			name: 'InvalidStateError'
		});
		expect(fake.sends).toEqual([]);
	});

	test.each([
		['USB_BAD_ARGS', 'TypeError'],
		['USB_NOT_FOUND', 'NotFoundError'],
		['USB_NOT_OPEN', 'InvalidStateError'],
		['USB_BUSY', 'InvalidStateError'],
		['USB_GUARD_REJECTED', 'NotAllowedError'],
		['USB_TRANSFER_FAILED', 'NotAllowedError'],
		['USB_TIMEOUT', 'NotAllowedError'],
		['USB_DETACHED', 'NotAllowedError'],
		['USB_PERMISSION_DENIED', 'NotAllowedError'],
		['USB_ORIGIN', 'SecurityError']
	])('sendReport rejected with %s is %s', async (code, name) => {
		const { device } = await openCable();
		fake.overrides.set('sendReport', () => {
			throw new CapacitorError(code, 'report refused');
		});
		const error: unknown = await device.sendReport(0xcb, new Uint8Array(31)).catch((e) => e);
		expect(error).toMatchObject({ name, message: `report refused (${code})` });
		expect(error instanceof TypeError).toBe(name === 'TypeError');
		expect(device.opened).toBe(
			!['USB_NOT_OPEN', 'USB_PERMISSION_DENIED', 'USB_DETACHED'].includes(code)
		);
	});
});

describe('NativeHIDDevice diagnostics', () => {
	test('opens a newly connected device before diagnostics, without sending reports', async () => {
		fake.plug(CABLE_A);
		const hid = new NativeHID(fake.plugin);
		const [device] = await hid.requestDevice({ filters: [] });
		if (device === undefined) throw new Error('no device');
		expect(device.opened).toBe(false);
		await expect(device.diagnostics()).resolves.toEqual(DIAGNOSTICS);
		expect(device.opened).toBe(true);
		expect(fake.calls.map(({ method }) => method)).toEqual([
			'requestDevice',
			'open',
			'diagnostics'
		]);
		expect(fake.sends).toEqual([]);
		await device.diagnostics();
		expect(fake.callsOf('open')).toHaveLength(1);
	});

	test('returns the validated diagnostics of the device', async () => {
		const { device } = await openCable();
		await expect(device.diagnostics()).resolves.toEqual(DIAGNOSTICS);
		fake.overrides.set('diagnostics', () => DIAGNOSTICS_DEBUG);
		await expect(device.diagnostics()).resolves.toEqual(DIAGNOSTICS_DEBUG);
		expect(fake.callsOf('diagnostics')).toEqual([{ key: CABLE_A.key }, { key: CABLE_A.key }]);
	});

	test.each([
		['USB_NOT_OPEN', 'InvalidStateError'],
		['USB_PERMISSION_DENIED', 'NotAllowedError'],
		['USB_DETACHED', 'NotAllowedError']
	])('diagnostics rejected with %s closes the cached session before retry', async (code, name) => {
		const { device } = await openCable();
		fake.opened.delete(CABLE_A.key);
		fake.overrides.set('diagnostics', () => {
			throw new CapacitorError(code, 'session lost');
		});
		await expect(device.diagnostics()).rejects.toMatchObject({
			name,
			message: `session lost (${code})`
		});
		expect(device.opened).toBe(false);
		fake.overrides.delete('diagnostics');
		await expect(device.diagnostics()).resolves.toEqual(DIAGNOSTICS);
		expect(fake.callsOf('open')).toHaveLength(2);
	});

	test('maps rejections and refuses malformed diagnostics', async () => {
		const { device } = await openCable();
		fake.overrides.set('diagnostics', () => {
			throw new CapacitorError('USB_NOT_OPEN', 'open the device first');
		});
		await expect(device.diagnostics()).rejects.toMatchObject({ name: 'InvalidStateError' });
		fake.lenient.add('diagnostics');
		for (const broken of [
			null,
			{ ...DIAGNOSTICS, transfer: 'bulk' },
			{ ...DIAGNOSTICS, rawDescriptorsHex: 'XYZ' },
			{ ...DIAGNOSTICS, endpoints: [{ ...DIAGNOSTICS.endpoints[0], direction: 'both' }] },
			{ ...DIAGNOSTICS, outputReports: [{ reportId: 0x1cb, bytes: 31 }] },
			{ ...DIAGNOSTICS, wireLog: [{ atMs: -1, hex: '' }] },
			{ ...DIAGNOSTICS, appVersion: '' }
		]) {
			fake.overrides.set('diagnostics', () => broken);
			await expect(device.diagnostics()).rejects.toThrow('malformed diagnostics');
		}
	});
});

describe('the core transport on NativeHID', () => {
	test('a revoked native session reopens on the next write and recovers after re-grant', async () => {
		const { hid, device } = await openCable();
		const clock = createFakeClock(0, { autoAdvance: true });
		fake.permitted.delete(CABLE_A.key);
		const interrupted = await writeCurve(device, NEUTRAL_BANDS, -0.5, { hid, clock });
		expect(interrupted).toMatchObject({
			status: 'interrupted',
			reportsSent: 0,
			committed: false,
			error: { name: 'NotAllowedError', message: expect.stringContaining('USB_PERMISSION_DENIED') }
		});
		expect(device.opened).toBe(false);
		expect(fake.opened.has(CABLE_A.key)).toBe(false);
		expect(fake.sends).toHaveLength(1);

		const denied = await writeCurve(device, NEUTRAL_BANDS, -0.5, { hid, clock });
		expect(denied).toMatchObject({ status: 'interrupted', reportsSent: 0, committed: false });
		expect(fake.callsOf('open')).toHaveLength(2);
		expect(fake.sends).toHaveLength(1);

		expect(await requestCable(hid)).toBe(device);
		const recovered = await writeCurve(device, NEUTRAL_BANDS, -0.5, { hid, clock });
		expect(recovered).toMatchObject({ status: 'ok', reportsSent: 9, committed: true });
		expect(fake.callsOf('open')).toEqual([
			{ key: CABLE_A.key },
			{ key: CABLE_A.key },
			{ key: CABLE_A.key }
		]);
		expect(fake.sends).toHaveLength(11);
		expect(decode(fake.sends[10]?.data ?? '')).toEqual([...commitReport()]);
	});

	test('requestCable and writeCurve write 9 reports and the commit, like WebHID', async () => {
		fake.plug(CABLE_A);
		const hid = new NativeHID(fake.plugin);
		const device = await requestCable(hid);
		if (device === null) throw new Error('no cable');
		expect(device).toBeInstanceOf(NativeHIDDevice);
		const clock = createFakeClock(0, { autoAdvance: true });
		const result = await writeCurve(device, NEUTRAL_BANDS, -0.5, { hid, clock });
		expect(result).toMatchObject({ status: 'ok', reportsSent: 9, committed: true });
		expect(fake.callsOf('requestDevice')).toEqual([
			{ filters: [{ vendorId: USB_VID, productId: USB_PID }] }
		]);
		expect(fake.callsOf('open')).toEqual([{ key: CABLE_A.key }]);
		expect(fake.sends).toHaveLength(10);
		for (const sent of fake.sends) {
			expect(sent.reportId).toBe(HID_REPORT_ID);
			expect(decode(sent.data)).toHaveLength(REPORT_SIZE);
		}
		expect(decode(fake.sends[9]?.data ?? '')).toEqual([...commitReport()]);
	});

	test('an unplug mid-write interrupts it and the commit is never sent', async () => {
		fake.plug(CABLE_A);
		const hid = new NativeHID(fake.plugin);
		const device = await requestCable(hid);
		if (device === null) throw new Error('no cable');
		let count = 0;
		fake.overrides.set('sendReport', () => {
			count += 1;
			if (count < 3) return undefined;
			fake.unplug(CABLE_A);
			throw new CapacitorError('USB_DETACHED', 'device detached');
		});
		const clock = createFakeClock(0, { autoAdvance: true });
		const result = await writeCurve(device, NEUTRAL_BANDS, -0.5, { hid, clock });
		expect(result).toMatchObject({ status: 'interrupted', reportsSent: 2, committed: false });
		expect(result.error).toMatchObject({ name: 'NotAllowedError' });
		expect(fake.sends).toHaveLength(3);
		expect(device.opened).toBe(false);
	});

	test('USB_BAD_ARGS before any accepted report is rethrown as a TypeError, like WebHID', async () => {
		fake.plug(CABLE_A);
		const hid = new NativeHID(fake.plugin);
		const device = await requestCable(hid);
		if (device === null) throw new Error('no cable');
		fake.overrides.set('sendReport', () => {
			throw new CapacitorError('USB_BAD_ARGS', 'invalid base64');
		});
		const clock = createFakeClock(0, { autoAdvance: true });
		await expect(writeCurve(device, NEUTRAL_BANDS, -0.5, { hid, clock })).rejects.toThrow(
			TypeError
		);
		expect(fake.sends).toHaveLength(1);
	});
});
