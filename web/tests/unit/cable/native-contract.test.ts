/**
 * Contract of the `OpenAuriUsb` bridge (schemas/android-usb-bridge-1.schema.json, bridgeApi 1)
 * checked with Ajv 2020 on the web side: the fixtures the fakes answer with, the events, the
 * rejections, and every request `NativeHID` sends.
 */
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, test } from 'vitest';
import { USB_PID, USB_VID } from 'open-auri/dsp';
import { requestCable } from 'open-auri/transport';
import {
	NATIVE_ERROR_CODES,
	NativeHID,
	SUPPORTED_BRIDGE_API,
	isNativeDeviceInfo,
	isUsbDiagnostics,
	toBase64,
	type NativeDeviceInfo,
	type NativeEventListener,
	type OpenAuriUsbPlugin,
	type UsbDiagnostics
} from '#lib/cable/native/index.ts';

const SCHEMA_ID = 'https://open-auri.com/schemas/android-usb-bridge-1.schema.json';
const SCHEMA_URL = new URL('../../../../schemas/android-usb-bridge-1.schema.json', import.meta.url);
const schema: { $defs: Record<string, Record<string, unknown>> } = JSON.parse(
	readFileSync(SCHEMA_URL, 'utf8')
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(schema);

function validator(definition: string) {
	const validate = ajv.getSchema(`${SCHEMA_ID}#/$defs/${definition}`);
	if (validate === undefined) throw new Error(`missing $defs/${definition}`);
	return validate;
}

function expectValid(definition: string, value: unknown): void {
	const validate = validator(definition);
	const valid = validate(value);
	expect(valid, `${definition}: ${ajv.errorsText(validate.errors)}`).toBe(true);
}

function expectInvalid(definition: string, value: unknown): void {
	const accepted = validator(definition)(value);
	expect(accepted, `${definition} accepted ${JSON.stringify(value)}`).toBe(false);
}

const CABLE: NativeDeviceInfo = {
	key: '/dev/bus/usb/001/002#1',
	vendorId: USB_VID,
	productId: USB_PID,
	productName: 'USB DSP Audio'
};

const INFO = { bridgeApi: 1, appVersion: '1.0.0', usbHost: true, webViewVersion: '141.0.7390.122' };

const DIAGNOSTICS: UsbDiagnostics = {
	device: CABLE,
	appVersion: '1.0.0',
	androidVersion: '15',
	webViewVersion: 'unknown',
	rawDescriptorsHex: '',
	hidInterfaceId: 0,
	endpoints: [{ address: 0x01, type: 'isochronous', direction: 'out', maxPacketSize: 0 }],
	reportDescriptorHex: '00ff',
	outputReports: [],
	transfer: 'control',
	paddedLength: 65536,
	kernelDriverDetached: false,
	wireLog: []
};

describe('the schema', () => {
	test('compiles under Ajv 2020 strict mode and defines every request and response', () => {
		for (const method of [
			'GetInfo',
			'RequestDevice',
			'GetDevices',
			'Open',
			'Close',
			'SendReport',
			'Diagnostics'
		]) {
			expect(validator(`${method}Request`)).toBeTypeOf('function');
			expect(validator(`${method}Response`)).toBeTypeOf('function');
		}
		expect(validator('ConnectEvent')).toBeTypeOf('function');
		expect(validator('DisconnectEvent')).toBeTypeOf('function');
	});

	test('the native error codes are exactly the ones the web maps', () => {
		expect(schema.$defs.ErrorCode?.enum).toEqual([...NATIVE_ERROR_CODES]);
		for (const code of NATIVE_ERROR_CODES) expectValid('Error', { code, message: 'x' });
		expectInvalid('Error', { code: 'USB_SOMETHING', message: 'x' });
		expectInvalid('Error', { code: 'USB_BUSY' });
	});

	test('the bridge API of the schema is the range the web supports', () => {
		const [min, max] = SUPPORTED_BRIDGE_API;
		expect(min).toBe(max);
		expect(schema.$defs.GetInfoResponse).toMatchObject({
			properties: { bridgeApi: { const: min } }
		});
	});
});

describe('fixtures used by the fakes', () => {
	test('answers', () => {
		expectValid('GetInfoResponse', INFO);
		expectValid('GetInfoResponse', { ...INFO, usbHost: false, webViewVersion: 'unknown' });
		expectValid('RequestDeviceResponse', { devices: [CABLE] });
		expectValid('RequestDeviceResponse', { devices: [] });
		const unnamed = { ...CABLE, key: 'x#2', productName: '' };
		expectValid('GetDevicesResponse', { devices: [CABLE, unnamed] });
		for (const definition of ['OpenResponse', 'CloseResponse', 'SendReportResponse']) {
			expectValid(definition, null);
		}
		expectValid('DiagnosticsResponse', DIAGNOSTICS);
		expectValid('DiagnosticsResponse', {
			...DIAGNOSTICS,
			wireLog: [{ atMs: 0, hex: 'cb00' }]
		});
		expect(isUsbDiagnostics(DIAGNOSTICS)).toBe(true);
	});

	test('events', () => {
		expectValid('ConnectEvent', { device: CABLE });
		expectValid('DisconnectEvent', { device: { ...CABLE, key: '/dev/bus/usb/001/003#12' } });
		expectInvalid('DisconnectEvent', null);
		expectInvalid('ConnectEvent', { device: { ...CABLE, key: 'no-counter' } });
	});

	test('the runtime device check accepts what the schema accepts and refuses its basic violations', () => {
		const valid = [
			CABLE,
			{ ...CABLE, productName: '' },
			{ ...CABLE, vendorId: 0, productId: 0xffff }
		];
		for (const device of valid) {
			expectValid('NativeDeviceInfo', device);
			expect(isNativeDeviceInfo(device)).toBe(true);
		}
		const invalid = [
			{ ...CABLE, key: '' },
			{ ...CABLE, vendorId: -1 },
			{ ...CABLE, productId: 0x10000 },
			{ ...CABLE, vendorId: 1.5 },
			{ key: CABLE.key, vendorId: USB_VID, productId: USB_PID },
			null,
			'device'
		];
		for (const device of invalid) {
			expectInvalid('NativeDeviceInfo', device);
			expect(isNativeDeviceInfo(device)).toBe(false);
		}
	});

	test('the runtime diagnostics check agrees with the schema on its violations', () => {
		const invalid = [
			{ ...DIAGNOSTICS, device: { ...CABLE, vendorId: 0x10000 } },
			{ ...DIAGNOSTICS, androidVersion: '' },
			{ ...DIAGNOSTICS, hidInterfaceId: 256 },
			{ ...DIAGNOSTICS, endpoints: [{ ...DIAGNOSTICS.endpoints[0], type: 'iso' }] },
			{ ...DIAGNOSTICS, reportDescriptorHex: 'ABCD' },
			{ ...DIAGNOSTICS, outputReports: [{ reportId: 1 }] },
			{ ...DIAGNOSTICS, paddedLength: 65537 },
			{ ...DIAGNOSTICS, kernelDriverDetached: 'yes' },
			{ ...DIAGNOSTICS, wireLog: [{ atMs: 1.5, hex: '00' }] },
			{ ...DIAGNOSTICS, wireLog: 'none' }
		];
		for (const diagnostics of invalid) {
			expectInvalid('UsbDiagnostics', diagnostics);
			expect(isUsbDiagnostics(diagnostics)).toBe(false);
		}
	});
});

describe('requests NativeHID sends', () => {
	/** Records every call as `[method, options]`, answering with valid fixtures. */
	function recorder() {
		const requests: [string, unknown][] = [];
		const listeners: NativeEventListener[] = [];
		const plugin: OpenAuriUsbPlugin = {
			getInfo: async () => {
				requests.push(['GetInfo', {}]);
				return INFO;
			},
			requestDevice: async (options) => {
				requests.push(['RequestDevice', options]);
				return { devices: [CABLE] };
			},
			getDevices: async () => {
				requests.push(['GetDevices', {}]);
				return { devices: [CABLE] };
			},
			open: async (options) => {
				requests.push(['Open', options]);
			},
			close: async (options) => {
				requests.push(['Close', options]);
			},
			sendReport: async (options) => {
				requests.push(['SendReport', options]);
			},
			diagnostics: async (options) => {
				requests.push(['Diagnostics', options]);
				return DIAGNOSTICS;
			},
			addListener: async (_name, listener) => {
				listeners.push(listener);
				return { remove: async () => undefined };
			}
		};
		return { plugin, requests, listeners };
	}

	test('every request of a full session conforms to its $defs', async () => {
		const { plugin, requests } = recorder();
		const hid = new NativeHID(plugin);
		const cable = await requestCable(hid);
		const filters = [{ vendorId: USB_VID }, { productId: USB_PID }, {}, { vendorId: 0 }];
		const [device] = await hid.requestDevice({ filters });
		await hid.requestDevice({ filters: [] });
		await hid.getDevices();
		if (device === undefined || cable === null) throw new Error('no device');
		expect(cable).toBe(device);
		await device.open();
		const buffer = new ArrayBuffer(96);
		new Uint8Array(buffer).set(Array.from({ length: 96 }, (_, index) => 255 - index));
		for (let length = 0; length <= 64; length++) {
			await device.sendReport(0xcb, new Uint8Array(buffer, 96 - length, length));
		}
		await device.sendReport(0, new DataView(buffer, 3, 31));
		await device.sendReport(255, new Uint32Array(buffer, 4, 8));
		await device.sendReport(0xcb, buffer);
		await device.diagnostics();
		await device.close();

		const methods = new Set(requests.map(([method]) => method));
		expect([...methods].sort()).toEqual([
			'Close',
			'Diagnostics',
			'GetDevices',
			'Open',
			'RequestDevice',
			'SendReport'
		]);
		expect(requests.filter(([method]) => method === 'SendReport')).toHaveLength(68);
		for (const [method, options] of requests) expectValid(`${method}Request`, options);
	});

	test('base64 of 0 to 64 bytes always matches the schema pattern and round-trips', () => {
		const pattern = validator('SendReportRequest');
		for (let length = 0; length <= 64; length++) {
			const bytes = Uint8Array.from({ length }, (_, index) => (index * 89 + length) & 0xff);
			const data = toBase64(bytes);
			expect(pattern({ key: CABLE.key, reportId: 0xcb, data })).toBe(true);
			expect(Array.from(atob(data), (char) => char.charCodeAt(0))).toEqual([...bytes]);
		}
	});

	test('a request NativeHID would refuse locally is also outside the contract', () => {
		expectInvalid('SendReportRequest', { key: CABLE.key, reportId: 256, data: '' });
		expectInvalid('SendReportRequest', { key: '', reportId: 0xcb, data: '' });
		expectInvalid('RequestDeviceRequest', { filters: [{ vendorId: 0x10000 }] });
		expectInvalid('RequestDeviceRequest', { filters: [{ usagePage: 0xff00 }] });
		expectInvalid('OpenRequest', { key: CABLE.key, extra: true });
	});
});
