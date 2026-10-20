import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Band } from '#lib/cable/types.ts';
import {
	createFakeClock,
	FakeHID,
	FakeHIDDevice,
	writeCurve,
	writeMany
} from 'open-auri/transport';
import { NativeHID, type OpenAuriUsbPlugin } from '#lib/cable/native/hid.ts';

interface Reference {
	constants: { commitCommand: number[] };
	presets: Record<string, { eqBands: Band[]; preampDb: number; reports: number[][] }>;
}

const reference: Reference = JSON.parse(
	readFileSync(new URL('../../../../test/fixtures/eq0xcb.reference.json', import.meta.url), 'utf8')
);
const curves = [
	...Object.entries(reference.presets).map(([id, preset]) => ({
		id,
		bands: preset.eqBands,
		preampDb: preset.preampDb,
		reports: preset.reports
	})),
	{
		id: 'neutro',
		bands: Array.from({ length: 10 }, (): Band => ({ kind: 'OFF' })),
		preampDb: -0.5,
		reports: undefined
	}
];
const commit = Array<number>(31).fill(0);
commit.splice(0, reference.constants.commitCommand.length, ...reference.constants.commitCommand);
const sequenceTimes = [...Array.from({ length: 9 }, (_, index) => index * 16), 9 * 16 + 150];

function rig(count: number) {
	const clock = createFakeClock(0, { autoAdvance: true });
	const sleeps: { at: number; ms: number }[] = [];
	const transportClock = {
		now: clock.now,
		sleep: (ms: number, signal?: AbortSignal) => {
			sleeps.push({ at: clock.now(), ms });
			return clock.sleep(ms, signal);
		}
	};
	const infos = Array.from({ length: count }, (_, index) => ({
		key: `/dev/bus/usb/001/${index + 1}#1`,
		vendorId: 0x3302,
		productId: 0x8902,
		productName: 'USB DSP Audio'
	}));
	const sent: { key: string; reportId: number; bytes: Uint8Array; at: number }[] = [];
	const plugin: OpenAuriUsbPlugin = {
		getInfo: async () => ({
			bridgeApi: 1,
			appVersion: '1.0.0',
			usbHost: true,
			webViewVersion: '140'
		}),
		requestDevice: async () => ({ devices: infos }),
		getDevices: async () => ({ devices: infos }),
		open: async () => undefined,
		close: async () => undefined,
		sendReport: async ({ key, reportId, data }) => {
			sent.push({
				key,
				reportId,
				bytes: Uint8Array.from(Buffer.from(data, 'base64')),
				at: clock.now()
			});
		},
		diagnostics: async () => {
			throw new Error('not used by the transport');
		},
		addListener: async () => ({ remove: async () => undefined })
	};
	const native = new NativeHID(plugin);
	const desktopDevices = infos.map(() => new FakeHIDDevice({ clock }));
	const desktop = new FakeHID({ devices: desktopDevices });
	return { clock, transportClock, sleeps, infos, sent, native, desktop, desktopDevices };
}

describe('real transport: NativeHID / desktop byte and timing parity', () => {
	it('covers exactly the eleven pinned presets plus Neutral', () => {
		expect(Object.keys(reference.presets)).toHaveLength(11);
		expect(curves).toHaveLength(12);
	});

	for (const curve of curves) {
		for (const count of [1, 2]) {
			it(`${curve.id}: ${count === 1 ? 'writeCurve' : 'writeMany, two cables'}`, async () => {
				// Independent clocks: one transport must not advance the other's timestamps.
				const desktop = rig(count);
				const native = rig(count);
				const nativeDevices = await native.native.requestDevice({
					filters: [{ vendorId: 0x3302, productId: 0x8902 }]
				});
				try {
					if (count === 1) {
						const a = await writeCurve(desktop.desktopDevices[0], curve.bands, curve.preampDb, {
							hid: desktop.desktop,
							clock: desktop.transportClock
						});
						const b = await writeCurve(nativeDevices[0], curve.bands, curve.preampDb, {
							hid: native.native,
							clock: native.transportClock
						});
						expect(b).toEqual(a);
						expect(b).toMatchObject({
							status: 'ok',
							reportsSent: 9,
							committed: true,
							startedAt: 0,
							finishedAt: 294
						});
					} else {
						const a = await writeMany(desktop.desktopDevices, curve.bands, curve.preampDb, {
							hid: desktop.desktop,
							clock: desktop.transportClock
						});
						const b = await writeMany(nativeDevices, curve.bands, curve.preampDb, {
							hid: native.native,
							clock: native.transportClock
						});
						const nativeResults = b.map(({ device, ...result }, index) => {
							expect(device).toBe(nativeDevices[index]);
							return result;
						});
						const desktopResults = a.map(({ device, ...result }, index) => {
							expect(device).toBe(desktop.desktopDevices[index]);
							return result;
						});
						expect(nativeResults).toEqual(desktopResults);
						expect(b.map((result) => result.status)).toEqual(['ok', 'ok']);
					}
					const desktopReports = desktop.desktopDevices.flatMap((device, index) =>
						device.sent.map((report) => ({ key: desktop.infos[index].key, ...report }))
					);
					expect(native.sent).toEqual(desktopReports);
					expect(native.sleeps).toEqual(desktop.sleeps);
					expect(native.sleeps.map(({ ms }) => ms)).toEqual(
						count === 1
							? [...Array<number>(9).fill(16), 150]
							: [...Array<number>(9).fill(16), 150, 2000, ...Array<number>(9).fill(16), 150]
					);
					for (let index = 0; index < count; index++) {
						const reports = native.sent.filter(({ key }) => key === native.infos[index].key);
						expect(reports.map(({ reportId }) => reportId)).toEqual(Array<number>(10).fill(0xcb));
						expect(reports.map(({ at }) => at)).toEqual(
							sequenceTimes.map((at) => at + index * 2294)
						);
						expect(Array.from(reports[9].bytes)).toEqual(commit);
						if (curve.reports)
							expect(reports.slice(0, 9).map(({ bytes }) => Array.from(bytes))).toEqual(
								curve.reports
							);
					}
					if (count === 2) expect(native.sent[10].at - native.sent[9].at).toBe(2000);
				} finally {
					await Promise.all([desktop.native.dispose(), native.native.dispose()]);
				}
			});
		}
	}
});
