import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { mount, unmount } from 'svelte';
import UsbDiagnostics from '#lib/components/pages/cabo/UsbDiagnostics.svelte';
import CaboPage from '#lib/components/pages/cabo/CaboPage.svelte';
import {
	NATIVE_CABLE_CONTEXT,
	type NativeCableState,
	type NativeCableStatus
} from '#lib/cable/native-state.svelte.ts';
import type { UsbDiagnostics as UsbReport } from '#lib/cable/native/index.ts';
import { NativeHIDDevice, type OpenAuriUsbPlugin } from '#lib/cable/native/hid.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import {
	ANDROID_PLAY_LIVE,
	ANDROID_PLAY_URL,
	ANDROID_RELEASES_URL,
	ANDROID_REPORT_URL
} from '#lib/cable/android-links.ts';

const report: UsbReport = {
	device: {
		key: 'usb-1',
		vendorId: 0x3302,
		productId: 0x8902,
		productName: '<img src=x onerror=alert(1)>'
	},
	appVersion: '1.0.0',
	androidVersion: '15',
	webViewVersion: '141',
	rawDescriptorsHex: '1201',
	hidInterfaceId: 1,
	endpoints: [],
	reportDescriptorHex: '0600ff',
	outputReports: [{ reportId: 0xcb, bytes: 31 }],
	transfer: 'control',
	paddedLength: 32,
	kernelDriverDetached: false
};
const device = () => ({ diagnostics: vi.fn(async () => report) });

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
});
afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

test.each([
	{ engineering: false, inApp: true, device: device() },
	{ engineering: true, inApp: false, device: device() },
	{ engineering: true, inApp: true, device: null }
])(
	'diagnostics require Engineering, the app and a connected native device: $engineering, $inApp',
	async (props) => {
		const screen = await render(UsbDiagnostics, props);
		expect(screen.container.querySelector('section')).toBeNull();
		if (props.device) expect(props.device.diagnostics).not.toHaveBeenCalled();
	}
);

test('load is opt-in, JSON is text only, clipboard copies it and nothing is uploaded', async () => {
	const native = device();
	const writeText = vi.fn(async () => undefined);
	vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText);
	const fetch = vi.spyOn(globalThis, 'fetch');
	const screen = await render(UsbDiagnostics, { engineering: true, inApp: true, device: native });
	expect(native.diagnostics).not.toHaveBeenCalled();
	expect(screen.container.querySelector('pre')).toBeNull();
	await page.getByRole('button', { name: m.android_diagnostics_load() }).click();
	await expect
		.poll(() => screen.container.querySelector('pre')?.textContent)
		.toBe(JSON.stringify(report, null, 2));
	expect(screen.container.querySelectorAll('img, script')).toHaveLength(0);
	expect(native.diagnostics).toHaveBeenCalledOnce();
	await page.getByRole('button', { name: m.android_diagnostics_copy(), exact: true }).click();
	expect(writeText).toHaveBeenCalledExactlyOnceWith(JSON.stringify(report, null, 2));
	await expect.element(page.getByRole('status')).toHaveTextContent(m.android_diagnostics_copied());
	await expect
		.element(page.getByRole('link', { name: m.android_report_result() }))
		.toHaveAttribute('href', ANDROID_REPORT_URL);
	expect(fetch).not.toHaveBeenCalled();
});

test('load works immediately after connecting a native device, before any write', async () => {
	let opened = false;
	const plugin: OpenAuriUsbPlugin = {
		getInfo: vi.fn(async () => undefined),
		requestDevice: vi.fn(async () => ({ devices: [report.device] })),
		getDevices: vi.fn(async () => ({ devices: [report.device] })),
		open: vi.fn(async () => {
			opened = true;
		}),
		close: vi.fn(async () => {
			opened = false;
		}),
		sendReport: vi.fn(async () => undefined),
		diagnostics: vi.fn(async () => {
			if (!opened)
				throw Object.assign(new Error('open the device first'), { code: 'USB_NOT_OPEN' });
			return report;
		}),
		addListener: vi.fn(async () => ({ remove: async () => undefined }))
	};
	const native = new NativeHIDDevice(plugin, report.device);
	const screen = await render(UsbDiagnostics, { engineering: true, inApp: true, device: native });
	expect(native.opened).toBe(false);
	expect(plugin.open).not.toHaveBeenCalled();
	await page.getByRole('button', { name: m.android_diagnostics_load() }).click();
	await expect
		.poll(() => screen.container.querySelector('pre')?.textContent)
		.toBe(JSON.stringify(report, null, 2));
	expect(plugin.open).toHaveBeenCalledExactlyOnceWith({ key: report.device.key });
	expect(plugin.diagnostics).toHaveBeenCalledExactlyOnceWith({ key: report.device.key });
	expect(plugin.sendReport).not.toHaveBeenCalled();
});

test('clipboard rejection and absent clipboard both show the manual-copy fallback', async () => {
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
	await render(UsbDiagnostics, { engineering: true, inApp: true, device: device() });
	await page.getByRole('button', { name: m.android_diagnostics_load() }).click();
	await page.getByRole('button', { name: m.android_diagnostics_copy(), exact: true }).click();
	await expect
		.element(page.getByRole('status'))
		.toHaveTextContent(m.android_diagnostics_copy_failed());
	const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
	Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
	try {
		await page.getByRole('button', { name: m.android_diagnostics_copy(), exact: true }).click();
		await expect
			.element(page.getByRole('status'))
			.toHaveTextContent(m.android_diagnostics_copy_failed());
	} finally {
		if (original) Object.defineProperty(navigator, 'clipboard', original);
		else Reflect.deleteProperty(navigator, 'clipboard');
	}
});

test('load failures are recoverable, and disconnect removes the report', async () => {
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	const native = device();
	native.diagnostics.mockRejectedValueOnce(new Error('unplugged'));
	const screen = await render(UsbDiagnostics, { engineering: true, inApp: true, device: native });
	await page.getByRole('button', { name: m.android_diagnostics_load() }).click();
	await expect
		.element(page.getByRole('status'))
		.toHaveTextContent(m.android_diagnostics_load_failed());
	await page.getByRole('button', { name: m.android_diagnostics_load() }).click();
	await expect
		.poll(() => screen.container.querySelector('pre')?.textContent)
		.toBe(JSON.stringify(report, null, 2));
	await screen.rerender({ device: null });
	expect(screen.container.querySelector('section')).toBeNull();
});

test('a pending report cannot reappear after the target changes', async () => {
	let finish: (value: UsbReport) => void = () => {
		throw new Error('No pending report');
	};
	const native = {
		diagnostics: vi.fn(
			() =>
				new Promise<UsbReport>((resolve) => {
					finish = resolve;
				})
		)
	};
	const screen = await render(UsbDiagnostics, { engineering: true, inApp: true, device: native });
	await page.getByRole('button', { name: m.android_diagnostics_load() }).click();
	await screen.rerender({ device: device() });
	finish(report);
	await expect.poll(() => screen.container.querySelector('pre')).toBeNull();
});

test.each<NativeCableStatus>([
	{ kind: 'native', appVersion: '1.2.3' },
	{ kind: 'native-outdated', appVersion: null },
	{ kind: 'native-outdated', appVersion: '0.9.0' },
	{ kind: 'native-write-disabled', appVersion: '1.0.0' },
	{ kind: 'native-no-usb-host', appVersion: '1.0.0' }
])(
	'Cabo displays shared native metadata and the correct safe fallback: $kind, $appVersion',
	async (status) => {
		const target = document.createElement('div');
		document.body.append(target);
		const state: NativeCableState = { result: status };
		const instance = mount(CaboPage, {
			target,
			context: new Map([[NATIVE_CABLE_CONTEXT, state]]),
			props: { app: null, tourAutoOpen: false }
		});
		try {
			const expected =
				status.kind === 'native'
					? m.android_native_status({ version: status.appVersion ?? '' })
					: status.kind === 'native-outdated'
						? m.android_native_outdated()
						: status.kind === 'native-write-disabled'
							? m.android_native_write_disabled()
							: m.android_native_no_usb_host();
			await expect.element(page.getByText(expected, { exact: true })).toBeVisible();
			await expect.element(page.getByText(m.android_untested_short())).toBeVisible();
			expect(target.querySelector('code.code')).toBeNull();
			expect(page.getByRole('link', { name: m.android_download_github() }).elements()).toHaveLength(
				0
			);
			expect(
				page.getByRole('button', { name: m.android_diagnostics_load() }).elements()
			).toHaveLength(0);
			if (status.kind === 'native-outdated' || status.kind === 'native-write-disabled') {
				await expect
					.element(page.getByRole('link', { name: m.android_update_app() }))
					.toHaveAttribute('href', ANDROID_PLAY_LIVE ? ANDROID_PLAY_URL : ANDROID_RELEASES_URL);
			}
			if (status.kind !== 'native') {
				await expect
					.element(page.getByText(m.cabo_simulation(), { exact: true }).first())
					.toBeVisible();
			}
		} finally {
			await unmount(instance);
			target.remove();
		}
	}
);
