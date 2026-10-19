import { readFile } from 'node:fs/promises';
import { test as base, expect, type BrowserContext, type Frame } from '@playwright/test';
import Ajv2020 from 'ajv/dist/2020.js';
import type { NativeDeviceInfo } from '../../../src/lib/cable/native/hid';

export interface NativeOptions {
	enabled?: boolean;
	bridgeApi?: number;
	appVersion?: string;
	usbHost?: boolean;
	devices?: NativeDeviceInfo[];
	permission?: 'granted' | 'denied';
	/** Zero-based send attempt, matching FakeHIDDevice's fault injection. */
	faults?: { detachAtReport?: number; timeoutAtReport?: number };
}

interface NativeCall {
	callbackId: string;
	pluginId: string;
	methodName: string;
	options: Record<string, unknown>;
}

interface Subscription {
	call: NativeCall;
	frame: Frame;
	eventName: 'connect' | 'disconnect';
}

export const cableInfo = (index = 0): NativeDeviceInfo => ({
	key: `/dev/bus/usb/001/${index + 1}#1`,
	vendorId: 0x3302,
	productId: 0x8902,
	productName: 'USB DSP Audio'
});

const USB_METHODS: Record<string, string> = {
	getInfo: 'GetInfo',
	requestDevice: 'RequestDevice',
	getDevices: 'GetDevices',
	open: 'Open',
	close: 'Close',
	sendReport: 'SendReport',
	diagnostics: 'Diagnostics'
};
const HEADERS = ['OpenAuriUsb', 'OpenAuriFiles'].map((name) => ({
	name,
	methods: [
		...(name === 'OpenAuriUsb' ? Object.keys(USB_METHODS) : ['save']).map((method) => ({
			name: method,
			rtype: 'promise'
		})),
		// Capacitor core's addListenerNative needs nativeCallback, not nativePromise.
		{ name: 'addListener', rtype: 'callback' },
		{ name: 'removeListener', rtype: 'callback' },
		{ name: 'removeAllListeners', rtype: 'promise' }
	]
}));

export class FakeAndroidNative {
	readonly calls: NativeCall[] = [];
	/** Accepted reports only; calls also records the failing send attempt. */
	readonly reports: { key: string; reportId: number; bytes: number[]; at: number }[] = [];
	readonly events: { name: 'connect' | 'disconnect'; device: NativeDeviceInfo }[] = [];
	readonly failures: string[] = [];
	readonly #options: NativeOptions;
	readonly #ajv = new Ajv2020({ allErrors: true, strict: true });
	readonly #devices = new Map<string, NativeDeviceInfo>();
	readonly #granted = new Set<string>();
	readonly #opened = new Set<string>();
	readonly #attempts = new Map<string, number>();
	readonly #listeners = new Map<string, Subscription>();
	#schemaId = '';

	constructor(options: NativeOptions) {
		this.#options = options;
		for (const device of options.devices ?? [cableInfo()]) this.#devices.set(device.key, device);
	}

	async install(context: BrowserContext): Promise<void> {
		const schema = JSON.parse(
			await readFile(
				new URL('../../../../schemas/android-usb-bridge-1.schema.json', import.meta.url),
				'utf8'
			)
		);
		this.#schemaId = schema.$id;
		this.#ajv.addSchema(schema);
		this.#ajv.addSchema({
			$id: 'native-call',
			type: 'object',
			additionalProperties: false,
			required: ['callbackId', 'pluginId', 'methodName', 'options'],
			properties: {
				callbackId: { type: 'string' },
				pluginId: { enum: ['OpenAuriUsb', 'OpenAuriFiles'] },
				methodName: { type: 'string' },
				options: { type: 'object' }
			}
		});
		this.#ajv.addSchema({
			$id: 'files-save',
			type: 'object',
			additionalProperties: false,
			required: ['name', 'mime', 'base64'],
			properties: {
				name: { type: 'string', minLength: 1 },
				mime: { type: 'string', minLength: 1 },
				base64: { $ref: `${this.#schemaId}#/$defs/SendReportRequest/properties/data` }
			}
		});
		await context.exposeBinding('__oaNative', async ({ frame }, json: string) => {
			let call: NativeCall | undefined;
			try {
				const parsed: unknown = JSON.parse(json);
				this.#validate('native-call', parsed);
				call = parsed as NativeCall;
				this.calls.push(call);
				await this.#dispatch(frame, call);
			} catch (cause) {
				// A bad payload must fail teardown even when the UI handles its rejected promise.
				this.failures.push(String(cause));
				if (call) await this.#reject(frame, call, 'USB_BAD_ARGS', String(cause));
			}
		});
		const bridge =
			this.#options.enabled === false
				? ''
				: await readFile(
						new URL(
							'../../../../node_modules/@capacitor/android/capacitor/src/main/assets/native-bridge.js',
							import.meta.url
						),
						'utf8'
					);
		// One init script guarantees ordering: androidBridge, PluginHeaders, then the REAL bridge.
		// No fake Capacitor methods, registerPlugin or replacement @capacitor/core implementation.
		await context.addInitScript({
			content: `
			localStorage.setItem('oa.tour.v1', JSON.stringify({cabo:'dispensado',curva:'dispensado'}));
			${
				this.#options.enabled === false
					? ''
					: `
			Object.defineProperty(navigator, 'hid', { configurable: true, value: undefined });
			window.androidBridge = { postMessage(json) { void window.__oaNative(json); } };
			window.Capacitor = { PluginHeaders: ${JSON.stringify(HEADERS)}, DEBUG: false, isLoggingEnabled: false };
			${bridge}`
			}
		`
		});
	}

	#validate(id: string, value: unknown): void {
		const validate = this.#ajv.getSchema(id);
		if (!validate) throw new Error(`Missing bridge schema ${id}`);
		if (!validate(value))
			throw new Error(`${id}: ${this.#ajv.errorsText(validate.errors)}; ${JSON.stringify(value)}`);
	}

	#usb(definition: string, value: unknown): void {
		this.#validate(`${this.#schemaId}#/$defs/${definition}`, value);
	}

	async #reply(
		frame: Frame,
		call: NativeCall,
		result:
			| { success: true; data?: unknown }
			| { success: false; error: { message: string; code: string } },
		save = false
	): Promise<void> {
		await frame.evaluate(
			(response) => {
				const win = window as Window & {
					androidBridge?: { onmessage(event: { data: string }): void };
				};
				if (!win.androidBridge) throw new Error('Real native bridge is not installed');
				win.androidBridge.onmessage({ data: JSON.stringify(response) });
			},
			{
				save,
				callbackId: call.callbackId,
				pluginId: call.pluginId,
				methodName: call.methodName,
				...result
			}
		);
	}

	async #reject(frame: Frame, call: NativeCall, code: string, message = code): Promise<void> {
		const error = { message, code };
		this.#usb('Error', error);
		await this.#reply(frame, call, { success: false, error });
	}

	async #dispatch(frame: Frame, call: NativeCall): Promise<void> {
		const { methodName: method, options } = call;
		if (method === 'addListener') {
			expect(Object.keys(options)).toEqual(['eventName']);
			expect(['connect', 'disconnect']).toContain(options.eventName);
			this.#listeners.set(call.callbackId, {
				call,
				frame,
				eventName: options.eventName as Subscription['eventName']
			});
			// No acknowledgement event: core resolves the handle from nativeCallback's ID.
			return;
		}
		if (method === 'removeListener') {
			expect(Object.keys(options).sort()).toEqual(['callbackId', 'eventName']);
			expect(typeof options.callbackId).toBe('string');
			this.#listeners.delete(String(options.callbackId));
			await this.#reply(frame, call, { success: true });
			return;
		}
		if (method === 'removeAllListeners') {
			this.#usb('NoOptions', options);
			this.#listeners.clear();
			await this.#reply(frame, call, { success: true });
			return;
		}
		if (call.pluginId === 'OpenAuriFiles') {
			expect(method).toBe('save');
			this.#validate('files-save', options);
			await this.#reply(frame, call, { success: true, data: { saved: true } });
			return;
		}
		const definition = USB_METHODS[method];
		if (!definition) throw new Error(`Unexpected USB method ${method}`);
		this.#usb(`${definition}Request`, options);
		let data: unknown = null;
		if (method === 'getInfo') {
			// Drop handles from the previous document on reload; real native does the same.
			for (const [id, listener] of this.#listeners)
				if (listener.frame === frame) this.#listeners.delete(id);
			data = {
				bridgeApi: this.#options.bridgeApi ?? 1,
				appVersion: this.#options.appVersion ?? '1.0.0',
				usbHost: this.#options.usbHost ?? true,
				webViewVersion: '140.0.7339.0'
			};
		} else if (method === 'requestDevice' || method === 'getDevices') {
			if (method === 'requestDevice' && this.#options.permission !== 'denied') {
				const filters = options.filters as { vendorId?: number; productId?: number }[];
				const chosen = [...this.#devices.values()].find(
					(device) =>
						!this.#granted.has(device.key) &&
						(filters.length === 0 ||
							filters.some(
								(filter) =>
									(filter.vendorId === undefined || filter.vendorId === device.vendorId) &&
									(filter.productId === undefined || filter.productId === device.productId)
							))
				);
				if (chosen) this.#granted.add(chosen.key);
				data = { devices: chosen ? [chosen] : [] };
			} else {
				data = {
					devices:
						method === 'getDevices'
							? [...this.#devices.values()].filter((device) => this.#granted.has(device.key))
							: []
				};
			}
		} else {
			const key = String(options.key);
			const device = this.#devices.get(key);
			if (!device) return this.#reject(frame, call, 'USB_NOT_FOUND');
			if (!this.#granted.has(key)) return this.#reject(frame, call, 'USB_PERMISSION_DENIED');
			if (method === 'open') this.#opened.add(key);
			if (method === 'close') this.#opened.delete(key);
			if (method === 'sendReport' || method === 'diagnostics') {
				if (!this.#opened.has(key)) return this.#reject(frame, call, 'USB_NOT_OPEN');
				if (method === 'sendReport') {
					const attempt = this.#attempts.get(key) ?? 0;
					this.#attempts.set(key, attempt + 1);
					if (attempt === this.#options.faults?.detachAtReport) {
						await this.disconnect(device);
						return this.#reject(frame, call, 'USB_DETACHED');
					}
					if (attempt === this.#options.faults?.timeoutAtReport)
						return this.#reject(frame, call, 'USB_TIMEOUT');
					this.reports.push({
						key,
						reportId: Number(options.reportId),
						bytes: [...Buffer.from(String(options.data), 'base64')],
						at: Date.now()
					});
				} else {
					data = {
						device,
						appVersion: this.#options.appVersion ?? '1.0.0',
						androidVersion: '15',
						webViewVersion: '140',
						rawDescriptorsHex: '',
						hidInterfaceId: 0,
						endpoints: [],
						reportDescriptorHex: '',
						outputReports: [{ reportId: 0xcb, bytes: 31 }],
						transfer: 'control',
						paddedLength: 32,
						kernelDriverDetached: false
					};
				}
			}
		}
		if (
			method === 'getInfo' &&
			this.#options.bridgeApi !== undefined &&
			this.#options.bridgeApi !== 1
		) {
			// Deliberate compatibility probe: only bridgeApi may violate the pinned v1 schema.
			const validate = this.#ajv.getSchema(`${this.#schemaId}#/$defs/GetInfoResponse`);
			if (!validate) throw new Error('Missing GetInfoResponse');
			expect(validate(data)).toBe(false);
			expect(
				validate.errors?.map(({ instancePath, keyword }) => ({ instancePath, keyword }))
			).toEqual([{ instancePath: '/bridgeApi', keyword: 'const' }]);
		} else this.#usb(`${definition}Response`, data);
		await this.#reply(frame, call, data === null ? { success: true } : { success: true, data });
	}

	async #emit(name: 'connect' | 'disconnect', device: NativeDeviceInfo): Promise<void> {
		this.#usb(name === 'connect' ? 'ConnectEvent' : 'DisconnectEvent', { device });
		this.events.push({ name, device });
		for (const { call, frame, eventName } of this.#listeners.values()) {
			if (eventName === name)
				await this.#reply(frame, call, { success: true, data: { device } }, true);
		}
	}

	async connect(device: NativeDeviceInfo, permitted = false): Promise<void> {
		this.#devices.set(device.key, device);
		if (permitted) this.#granted.add(device.key);
		await this.#emit('connect', device);
	}

	async disconnect(device: NativeDeviceInfo): Promise<void> {
		this.#devices.delete(device.key);
		this.#granted.delete(device.key);
		this.#opened.delete(device.key);
		await this.#emit('disconnect', device);
	}

	assertValid(): void {
		expect(this.failures, 'native bridge schema/protocol failures').toEqual([]);
	}
}

export const test = base.extend<{ nativeBridge: FakeAndroidNative; nativeOptions: NativeOptions }>({
	nativeOptions: [{}, { option: true }],
	nativeBridge: [
		async ({ context, nativeOptions }, use) => {
			const native = new FakeAndroidNative(nativeOptions);
			await native.install(context);
			await use(native);
			native.assertValid();
		},
		{ auto: true }
	]
});
export { expect };
