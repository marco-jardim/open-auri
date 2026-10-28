import { existsSync, readFileSync } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { createToastStore } from '#lib/components/chrome/toast.ts';
import {
	isNativeAndroid,
	mountNativeCable,
	type NativeCableState
} from '#lib/app/context.svelte.ts';
import {
	NativeHID,
	type NativeCableDetection,
	type OpenAuriUsbPlugin
} from '#lib/cable/native/index.ts';
import type { ClientAppOptions } from '#lib/app/client.svelte.ts';

afterEach(() => vi.unstubAllGlobals());

const source = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

function setup() {
	const toasts = createToastStore();
	const state: NativeCableState = { result: { kind: 'none' } };
	const mount = vi.fn(async (options: ClientAppOptions) => options);
	return { toasts, state, mount };
}

test('desktop mounts synchronously with only toasts, without calling or waiting for detection', async () => {
	vi.stubGlobal('window', {});
	const { toasts, state, mount } = setup();
	const detect = vi.fn<() => Promise<NativeCableDetection>>();
	const pending = mountNativeCable(mount, toasts, state, { detect });
	expect(mount).toHaveBeenCalledExactlyOnceWith({ toasts });
	expect(detect).not.toHaveBeenCalled();
	expect(state.result).toEqual({ kind: 'none' });
	expect(await pending).toEqual({ toasts });
});

test('native detection finishes and publishes metadata before mounting with its HID', async () => {
	const { toasts, state, mount } = setup();
	const plugin: OpenAuriUsbPlugin = {
		getInfo: async () => undefined,
		requestDevice: async () => ({ devices: [] }),
		getDevices: async () => ({ devices: [] }),
		open: async () => undefined,
		close: async () => undefined,
		sendReport: async () => undefined,
		diagnostics: async () => undefined,
		addListener: async () => ({ remove: async () => undefined })
	};
	const hid = new NativeHID(plugin);
	const result: NativeCableDetection = {
		kind: 'native',
		hid,
		appVersion: '1.2.3',
		webViewVersion: '141',
		liveApply: false
	};
	let finish: (result: NativeCableDetection) => void = () => {
		throw new Error('No pending detection');
	};
	const detect = vi.fn(
		() =>
			new Promise<NativeCableDetection>((resolve) => {
				finish = resolve;
			})
	);
	const pending = mountNativeCable(mount, toasts, state, { isNative: () => true, detect });
	expect(mount).not.toHaveBeenCalled();
	finish(result);
	await pending;
	expect(detect).toHaveBeenCalledOnce();
	expect(mount).toHaveBeenCalledExactlyOnceWith({ toasts, cable: { hid } });
	expect(state.result).toEqual({ kind: 'native', appVersion: '1.2.3' });
	expect(state.result).not.toHaveProperty('hid');
});

test.each<NativeCableDetection>([
	{ kind: 'native-outdated', appVersion: null },
	{ kind: 'native-outdated', appVersion: '0.9.0' },
	{ kind: 'native-write-disabled', appVersion: '1.0.0' },
	{ kind: 'native-no-usb-host', appVersion: '1.0.0' },
	{ kind: 'none' }
])('$kind exposes its state and retains the original simulated fallback call', async (result) => {
	const { toasts, state, mount } = setup();
	await mountNativeCable(mount, toasts, state, {
		isNative: () => true,
		detect: async () => result
	});
	expect(mount).toHaveBeenCalledExactlyOnceWith({ toasts });
	expect(state.result).toEqual(result);
});

test('layout uses the tested mount path and lazy notice; Capacitor remains behind the native dynamic import', () => {
	const layout = source('src/routes/+layout.svelte');
	const state = source('src/lib/app/context.svelte.ts');
	const cabo = source('src/lib/components/pages/cabo/CaboPage.svelte');
	const callout = source('src/lib/components/cable/AndroidAppCallout.svelte');
	const index = source('src/lib/cable/native/index.ts');
	const detect = source('src/lib/cable/native/detect.ts');
	expect(layout).toContain('mountNativeCable(');
	expect(layout).toContain('context.mount(options, mountOptions)');
	expect(layout).toContain("() => import('#lib/components/cable/AndroidUntestedNotice.svelte')");
	expect(layout).toContain(
		String.raw`page.url.pathname.replace(/\/$/, '') === '/docs' ? 'banner' : 'modal'`
	);
	expect(state).toContain('if (!isNative()) return mount({ toasts });');
	expect(state).toContain("await import('#lib/cable/native/index.ts')");
	for (const text of [layout, state, cabo, callout]) {
		expect(text).not.toMatch(
			/import\s+(?!type\b)[^;]*?\bfrom\s*['"]#lib\/cable\/(?:native-state|native\/)/
		);
	}
	expect(cabo).not.toContain('instanceof NativeHIDDevice');
	expect(index).not.toMatch(/from\s+['"].*bridge/);
	for (const text of [layout, state, index, detect]) {
		expect(text).not.toMatch(/(?:from\s*|import\s*)['"]@capacitor\/core/);
	}
	expect(detect).toContain("import('./bridge.ts')");
});

test('the initial-chunk gate only accepts native Android and fails closed on hostile globals', () => {
	expect(isNativeAndroid({})).toBe(false);
	expect(isNativeAndroid({ Capacitor: null })).toBe(false);
	for (const platform of ['android', 'ios', 'web']) {
		for (const native of [true, false]) {
			expect(
				isNativeAndroid({
					Capacitor: { isNativePlatform: () => native, getPlatform: () => platform }
				})
			).toBe(native && platform === 'android');
		}
	}
	const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	expect(
		isNativeAndroid({
			get Capacitor() {
				throw new Error('blocked');
			}
		})
	).toBe(false);
	expect(warning).toHaveBeenCalledOnce();
	warning.mockRestore();
});

function catalog(locale: string): Record<string, string> {
	const staging = new URL(`../../../messages/_staging/T2.3.${locale}.json`, import.meta.url);
	const merged = new URL(`../../../messages/${locale}.json`, import.meta.url);
	return JSON.parse(readFileSync(existsSync(staging) ? staging : merged, 'utf8'));
}

test('staging keys match, sort and contain the exact G.1, G.2 and G.4 copy in both languages', () => {
	const pt = catalog('pt-BR');
	const en = catalog('en-US');
	const keys = Object.keys(pt).filter((key) => key.startsWith('android_'));
	expect(keys).toEqual([...keys].sort());
	expect(keys).toEqual(Object.keys(en).filter((key) => key.startsWith('android_')));
	const plan = readFileSync(
		new URL('../../../../docs/plans/2026-10-18-android-capacitor-plano.md', import.meta.url),
		'utf8'
	);
	for (const messages of [pt, en]) {
		for (const key of [
			'android_untested_title',
			'android_untested_body',
			'android_untested_short',
			'android_native_write_disabled'
		]) {
			expect(plan).toContain(`"${messages[key]}"`);
		}
		expect(keys.map((key) => messages[key]).join('\n')).not.toContain('\u2014');
	}
});
