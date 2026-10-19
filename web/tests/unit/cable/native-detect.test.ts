import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import type { AndroidWritePolicy } from '#lib/cable/android-status.ts';
import {
	HANDSHAKE_TIMEOUT_MS,
	SUPPORTED_BRIDGE_API,
	detectNativeCable,
	isNativeAndroid,
	isSupportedBridgeApi,
	type NativeBridgeModule
} from '#lib/cable/native/detect.ts';
import { NativeHID, type OpenAuriUsbPlugin } from '#lib/cable/native/hid.ts';
import type { HidLike } from '#lib/cable/types.ts';

const SCHEMA_ID = 'https://open-auri.com/schemas/android-usb-bridge-1.schema.json';
const SCHEMA_URL = new URL('../../../../schemas/android-usb-bridge-1.schema.json', import.meta.url);
const ajv = new Ajv2020({ allErrors: true });
ajv.addSchema(JSON.parse(readFileSync(SCHEMA_URL, 'utf8')));

function conforms(definition: string, value: unknown): boolean {
	const validate = ajv.getSchema(`${SCHEMA_ID}#/$defs/${definition}`);
	if (validate === undefined) throw new Error(`missing $defs/${definition}`);
	return validate(value) === true;
}

/** The app's `getInfo()` answer (bridgeApi 1). */
const INFO = Object.freeze({
	bridgeApi: 1,
	appVersion: '1.0.0',
	usbHost: true,
	webViewVersion: '141.0.7390.122'
});

function capacitorWindow(isNativePlatform: unknown, getPlatform?: unknown) {
	return { Capacitor: { isNativePlatform, getPlatform } };
}

/** What `native-bridge.js` defines in the app before any site code runs. */
const ANDROID = capacitorWindow(
	() => true,
	() => 'android'
);
/** What importing `@capacitor/core` creates in a normal browser. */
const WEB = capacitorWindow(
	() => false,
	() => 'web'
);

/** A fake plugin with every method mocked; `then` catches any attempt to await the proxy. */
function fakePlugin(getInfo: () => Promise<unknown>) {
	const fake = {
		getInfo: vi.fn(getInfo),
		requestDevice: vi.fn(async () => ({ devices: [] })),
		getDevices: vi.fn(async () => ({ devices: [] })),
		open: vi.fn(async () => undefined),
		close: vi.fn(async () => undefined),
		sendReport: vi.fn(async () => undefined),
		diagnostics: vi.fn(async () => undefined),
		addListener: vi.fn(async () => ({ remove: async () => undefined })),
		then: vi.fn((_resolve: unknown, reject: (reason: unknown) => void) =>
			reject(new Error('the plugin proxy was awaited'))
		)
	};
	const plugin: OpenAuriUsbPlugin = fake;
	/** Calls other than getInfo (I/O, listeners, or being awaited). */
	const otherCalls = () =>
		[
			fake.requestDevice,
			fake.getDevices,
			fake.open,
			fake.close,
			fake.sendReport,
			fake.diagnostics,
			fake.addListener,
			fake.then
		].reduce((sum, mock) => sum + mock.mock.calls.length, 0);
	const loadBridge = vi.fn(async (): Promise<NativeBridgeModule> => ({ OpenAuriUsb: plugin }));
	return { fake, plugin, otherCalls, loadBridge };
}

function answering(info: unknown) {
	return fakePlugin(async () => info);
}

let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
	warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('the synchronous gate', () => {
	test.each<[string, object | undefined]>([
		['no window', undefined],
		['a plain browser', {}],
		['@capacitor/core in a browser', WEB],
		[
			'the iOS app',
			capacitorWindow(
				() => true,
				() => 'ios'
			)
		],
		[
			'a truthy non-boolean',
			capacitorWindow(
				() => 'yes',
				() => 'android'
			)
		],
		['isNativePlatform not a function', capacitorWindow(true, () => 'android')],
		['getPlatform missing', capacitorWindow(() => true)],
		['getPlatform not a function', capacitorWindow(() => true, 'android')],
		['Capacitor not an object', { Capacitor: 'android' }],
		['Capacitor null', { Capacitor: null }]
	])('%s is not the Android app', (_name, win) => {
		expect(isNativeAndroid(win)).toBe(false);
	});

	test('the Android app is detected, with this bound to window.Capacitor', () => {
		const capacitor = {
			platform: 'android',
			isNativePlatform(): boolean {
				return this.platform === 'android';
			},
			getPlatform(): string {
				return this.platform;
			}
		};
		expect(isNativeAndroid(ANDROID)).toBe(true);
		expect(isNativeAndroid({ Capacitor: capacitor })).toBe(true);
	});

	test('a hostile window.Capacitor reads as "no" and never throws', () => {
		const win = Object.defineProperty({}, 'Capacitor', {
			get() {
				throw new Error('forged');
			}
		});
		const throwing = {
			Capacitor: {
				isNativePlatform: () => {
					throw new Error('forged');
				}
			}
		};
		expect(isNativeAndroid(win)).toBe(false);
		expect(isNativeAndroid(throwing)).toBe(false);
		expect(warn).toHaveBeenCalledTimes(2);
	});

	test('outside a browser the default window is absent', () => {
		expect(typeof window).toBe('undefined');
		expect(isNativeAndroid()).toBe(false);
	});

	test('in a browser the default window is the global one', async () => {
		vi.stubGlobal('window', ANDROID);
		const { loadBridge } = answering(INFO);
		expect(isNativeAndroid()).toBe(true);
		await expect(detectNativeCable({ loadBridge })).resolves.toMatchObject({ kind: 'native' });
		expect(loadBridge).toHaveBeenCalledTimes(1);
	});
});

describe('detectNativeCable outside the app', () => {
	test.each<[string, { win?: object } | undefined]>([
		['default options (no window here)', undefined],
		['an explicit missing window', { win: undefined }],
		['a plain browser', { win: {} }],
		['@capacitor/core in a browser', { win: WEB }]
	])('%s: none, and the bridge is never imported', async (_name, options) => {
		const loadBridge = vi.fn(async (): Promise<NativeBridgeModule> => {
			throw new Error('must not load');
		});
		const result = await detectNativeCable(
			options === undefined ? undefined : { ...options, loadBridge }
		);
		expect(result).toEqual({ kind: 'none' });
		expect(loadBridge).not.toHaveBeenCalled();
	});
});

describe('detectNativeCable in the app', () => {
	test('current app: native, with a NativeHID and no plugin call besides getInfo', async () => {
		const { fake, otherCalls, loadBridge } = answering(INFO);
		const result = await detectNativeCable({ win: ANDROID, loadBridge });
		expect(result).toMatchObject({
			kind: 'native',
			appVersion: '1.0.0',
			webViewVersion: '141.0.7390.122'
		});
		if (result.kind !== 'native') throw new Error('not native');
		const hid: HidLike = result.hid;
		expect(hid).toBeInstanceOf(NativeHID);
		expect(loadBridge).toHaveBeenCalledTimes(1);
		expect(fake.getInfo).toHaveBeenCalledTimes(1);
		expect(fake.getInfo.mock.calls[0]).toEqual([]);
		expect(otherCalls()).toBe(0);
		expect(warn).not.toHaveBeenCalled();
	});

	test('the default policy (writing on, nothing blocked) lets the current app write', async () => {
		const { loadBridge } = answering({ ...INFO, appVersion: '0.0.1-rc.1' });
		const result = await detectNativeCable({ win: ANDROID, loadBridge });
		expect(result.kind).toBe('native');
	});

	test.each([
		['bridgeApi 2 (newer app)', { ...INFO, bridgeApi: 2, appVersion: '2.0.0' }, '2.0.0'],
		['bridgeApi 0 (older app)', { ...INFO, bridgeApi: 0, appVersion: '0.9.0' }, '0.9.0'],
		['bridgeApi as a string', { ...INFO, bridgeApi: '1' }, '1.0.0'],
		['bridgeApi not an integer', { ...INFO, bridgeApi: 1.5 }, '1.0.0'],
		[
			'bridgeApi missing',
			{ appVersion: '1.0.0', usbHost: true, webViewVersion: 'unknown' },
			'1.0.0'
		],
		['usbHost missing', { bridgeApi: 1, appVersion: '1.0.0', webViewVersion: 'unknown' }, '1.0.0'],
		['webViewVersion empty', { ...INFO, webViewVersion: '' }, '1.0.0'],
		['webViewVersion missing', { bridgeApi: 1, appVersion: '1.0.0', usbHost: true }, '1.0.0'],
		['appVersion empty', { ...INFO, appVersion: '' }, null],
		['appVersion not a string', { ...INFO, appVersion: 100 }, null],
		['a null answer', null, null],
		['a string answer', 'bridgeApi=1', null]
	])('%s: outdated, with no other plugin call', async (_name, info, appVersion) => {
		const { otherCalls, loadBridge } = answering(info);
		const policy: AndroidWritePolicy = { enabled: false, blockedAppVersions: [] };
		const result = await detectNativeCable({ win: ANDROID, loadBridge, policy });
		expect(result).toEqual({ kind: 'native-outdated', appVersion });
		expect(otherCalls()).toBe(0);
	});

	test('a failed handshake is outdated with an unknown version, never a crash', async () => {
		const failing = fakePlugin(async () => {
			throw Object.assign(new Error('"OpenAuriUsb" plugin is not implemented on android'), {
				code: 'UNIMPLEMENTED'
			});
		});
		const failed = await detectNativeCable({ win: ANDROID, loadBridge: failing.loadBridge });
		expect(failed).toEqual({ kind: 'native-outdated', appVersion: null });
		expect(failing.otherCalls()).toBe(0);

		const loadBridge = vi.fn(async (): Promise<NativeBridgeModule> => {
			throw new TypeError('Failed to fetch dynamically imported module');
		});
		await expect(detectNativeCable({ win: ANDROID, loadBridge })).resolves.toEqual({
			kind: 'native-outdated',
			appVersion: null
		});
		expect(warn).toHaveBeenCalledWith('OpenAuriUsb handshake failed', expect.any(Error));
	});

	test('a hanging handshake times out after HANDSHAKE_TIMEOUT_MS: outdated', async () => {
		vi.useFakeTimers();
		const hanging = fakePlugin(() => new Promise(() => undefined));
		let settled = false;
		const pending = detectNativeCable({ win: ANDROID, loadBridge: hanging.loadBridge });
		void pending.then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS - 1);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await expect(pending).resolves.toEqual({ kind: 'native-outdated', appVersion: null });
		expect(hanging.otherCalls()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	test('a bridge module that never loads times out too (custom timeout)', async () => {
		vi.useFakeTimers();
		const loadBridge = vi.fn(() => new Promise<NativeBridgeModule>(() => undefined));
		const pending = detectNativeCable({ win: ANDROID, loadBridge, timeoutMs: 50 });
		await vi.advanceTimersByTimeAsync(50);
		await expect(pending).resolves.toEqual({ kind: 'native-outdated', appVersion: null });
	});

	test('a fast handshake leaves no timer behind', async () => {
		vi.useFakeTimers();
		const { loadBridge } = answering(INFO);
		await expect(detectNativeCable({ win: ANDROID, loadBridge })).resolves.toMatchObject({
			kind: 'native'
		});
		expect(vi.getTimerCount()).toBe(0);
	});

	test('no USB host: native-no-usb-host, no NativeHID and no other plugin call', async () => {
		const { otherCalls, loadBridge } = answering({ ...INFO, usbHost: false });
		const result = await detectNativeCable({ win: ANDROID, loadBridge });
		expect(result).toEqual({ kind: 'native-no-usb-host', appVersion: '1.0.0' });
		expect(otherCalls()).toBe(0);
	});

	test.each<[string, AndroidWritePolicy, string]>([
		['writing turned off', { enabled: false, blockedAppVersions: [] }, '1.0.0'],
		['this exact version blocked', { enabled: true, blockedAppVersions: ['1.0.0'] }, '1.0.0'],
		['versions below a bound blocked', { enabled: true, blockedAppVersions: ['<1.0.3'] }, '1.0.2'],
		['a version that is not SemVer', { enabled: true, blockedAppVersions: [] }, 'banana']
	])(
		'%s: write-disabled, no hid, ZERO plugin calls besides getInfo',
		async (_, policy, version) => {
			const appVersion = version;
			const { fake, otherCalls, loadBridge } = answering({ ...INFO, appVersion });
			const result = await detectNativeCable({ win: ANDROID, loadBridge, policy });
			expect(result).toEqual({ kind: 'native-write-disabled', appVersion });
			expect(result).not.toHaveProperty('hid');
			expect(fake.getInfo).toHaveBeenCalledTimes(1);
			expect(otherCalls()).toBe(0);
		}
	);

	test('order: outdated before the policy, the policy before the USB host', async () => {
		const disabled: AndroidWritePolicy = { enabled: false, blockedAppVersions: [] };
		const outdated = answering({ ...INFO, bridgeApi: 2, usbHost: false });
		await expect(
			detectNativeCable({ win: ANDROID, loadBridge: outdated.loadBridge, policy: disabled })
		).resolves.toEqual({ kind: 'native-outdated', appVersion: '1.0.0' });
		const noHost = answering({ ...INFO, usbHost: false });
		await expect(
			detectNativeCable({ win: ANDROID, loadBridge: noHost.loadBridge, policy: disabled })
		).resolves.toEqual({ kind: 'native-write-disabled', appVersion: '1.0.0' });
		const allowed = answering({ ...INFO, usbHost: false });
		await expect(
			detectNativeCable({
				win: ANDROID,
				loadBridge: allowed.loadBridge,
				policy: { enabled: true, blockedAppVersions: ['<0.1.0'] }
			})
		).resolves.toEqual({ kind: 'native-no-usb-host', appVersion: '1.0.0' });
	});
});

describe('bridge API range', () => {
	test('SUPPORTED_BRIDGE_API is [1, 1] and inclusive', () => {
		expect(SUPPORTED_BRIDGE_API).toEqual([1, 1]);
		expect(Object.isFrozen(SUPPORTED_BRIDGE_API)).toBe(true);
		expect(isSupportedBridgeApi(1)).toBe(true);
		for (const value of [0, 2, 1.5, '1', null, undefined, Number.NaN]) {
			expect(isSupportedBridgeApi(value)).toBe(false);
		}
	});

	test('the handshake fixtures: the current one is the contract, the outdated ones are not', () => {
		expect(conforms('GetInfoRequest', {})).toBe(true);
		expect(conforms('GetInfoResponse', INFO)).toBe(true);
		expect(conforms('GetInfoResponse', { ...INFO, usbHost: false })).toBe(true);
		expect(conforms('GetInfoResponse', { ...INFO, appVersion: '0.0.1-rc.1' })).toBe(true);
		expect(conforms('GetInfoResponse', { ...INFO, appVersion: 'banana' })).toBe(true);
		expect(conforms('GetInfoResponse', { ...INFO, bridgeApi: 2 })).toBe(false);
		expect(conforms('GetInfoResponse', { ...INFO, bridgeApi: 0 })).toBe(false);
		expect(conforms('GetInfoResponse', { ...INFO, webViewVersion: '' })).toBe(false);
	});
});

describe('the desktop path never loads @capacitor/core', () => {
	const read = (name: string) =>
		readFileSync(new URL(`../../../src/lib/cable/native/${name}`, import.meta.url), 'utf8');
	const CAPACITOR = /['"]@capacitor\/core['"]/;
	const BRIDGE_STATIC = /(?:from|import)\s+['"]\.\/bridge(?:\.ts)?['"]/;

	test('only bridge.ts imports @capacitor/core, and nothing imports bridge.ts statically', () => {
		for (const name of ['detect.ts', 'hid.ts', 'errors.ts', 'index.ts']) {
			const source = read(name);
			expect(source, name).not.toMatch(CAPACITOR);
			expect(source, name).not.toMatch(BRIDGE_STATIC);
		}
		expect(read('bridge.ts')).toMatch(/import \{ registerPlugin \} from '@capacitor\/core';/);
		expect(read('detect.ts')).toContain("import('./bridge.ts')");
		expect(read('index.ts')).not.toContain("bridge.ts'");
	});

	test('the default loader imports the real bridge only in the app (here it is not implemented)', async () => {
		expect(Reflect.has(globalThis, 'Capacitor')).toBe(false);
		const result = await detectNativeCable({ win: ANDROID });
		// @capacitor/core in Node is the web platform: the plugin call is not implemented.
		expect(result).toEqual({ kind: 'native-outdated', appVersion: null });
		expect(warn).toHaveBeenCalledWith(
			'OpenAuriUsb handshake failed',
			expect.objectContaining({ code: 'UNIMPLEMENTED' })
		);
		const bridge = await import('#lib/cable/native/bridge.ts');
		expect(bridge.OPEN_AURI_USB_PLUGIN).toBe('OpenAuriUsb');
		expect(isNativeAndroid(globalThis)).toBe(false);
		Reflect.deleteProperty(globalThis, 'Capacitor');
	});
});
