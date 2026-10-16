import type { Page } from '@playwright/test';

export interface HidReport {
	device: number;
	reportId: number;
	bytes: number[];
	/** Monotonic browser time at the sendReport call, without rounding. */
	at: number;
	epochMs: number;
}

interface HidFilter {
	vendorId?: number;
	productId?: number;
}

export interface HidLog {
	reports: HidReport[];
	requests: { filters: HidFilter[] }[];
	disconnects: { device: number; at: number }[];
	timers: HidTimer[];
}

export interface HidTimer {
	delayMs: number;
	scheduledAt: number;
	firedAt: number | null;
}

interface HidStubOptions {
	devices?: number;
	/** One-based sendReport call on disconnectDevice (including the commit). */
	disconnectAtReport?: number;
	/** Zero-based device index. */
	disconnectDevice?: number;
	absent?: boolean;
	/** Observe native page timers after the first send, without changing their delays. */
	recordTimers?: boolean;
}

type StubWindow = typeof globalThis & { __bHid: HidLog };

/** Only the browser's hardware boundary is replaced; no app/service APIs are exposed. */
export async function installHidStub(page: Page, options: HidStubOptions = {}): Promise<void> {
	await page.addInitScript(
		({ devices, disconnectAtReport, disconnectDevice, absent, recordTimers }) => {
			const log: HidLog = { reports: [], requests: [], disconnects: [], timers: [] };
			Object.defineProperty(globalThis, '__bHid', { value: log, configurable: true });
			if (absent) {
				Object.defineProperty(navigator, 'hid', { value: undefined, configurable: true });
				return;
			}
			if (recordTimers) {
				const nativeSetTimeout = window.setTimeout.bind(window);
				Object.defineProperty(window, 'setTimeout', {
					configurable: true,
					value: (handler: TimerHandler, delayMs = 0, ...args: unknown[]) => {
						if (typeof handler !== 'function' || log.reports.length === 0) {
							return nativeSetTimeout(handler, delayMs, ...args);
						}
						const timer: HidTimer = { delayMs, scheduledAt: performance.now(), firedAt: null };
						log.timers.push(timer);
						return nativeSetTimeout(
							(...callbackArgs: unknown[]) => {
								timer.firedAt = performance.now();
								handler.apply(window, callbackArgs);
							},
							delayMs,
							...args
						);
					}
				});
			}

			const events = new EventTarget();
			const permitted = new Set<number>();
			let nextDevice = 0;
			const cables = Array.from({ length: devices }, (_, index) => {
				let connected = true;
				let reportCount = 0;
				return {
					vendorId: 0x3302,
					productId: 0x8902,
					productName: 'USB DSP Audio',
					serialNumber: `b-cable-${index + 1}`,
					opened: false,
					async open() {
						if (!connected) throw new DOMException('Cable disconnected', 'NetworkError');
						this.opened = true;
					},
					async close() {
						this.opened = false;
					},
					async sendReport(reportId: number, data: ArrayBuffer | ArrayBufferView) {
						if (!connected || !this.opened) {
							throw new DOMException('Cable is not open', 'InvalidStateError');
						}
						const bytes = ArrayBuffer.isView(data)
							? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
							: new Uint8Array(data);
						log.reports.push({
							device: index,
							reportId,
							bytes: Array.from(bytes),
							at: performance.now(),
							epochMs: Date.now()
						});
						reportCount += 1;
						if (index === disconnectDevice && reportCount === disconnectAtReport) {
							connected = false;
							this.opened = false;
							log.disconnects.push({ device: index, at: performance.now() });
							const event = new Event('disconnect');
							Object.defineProperty(event, 'device', { value: this });
							events.dispatchEvent(event);
							throw new DOMException('Cable unplugged during report', 'NetworkError');
						}
					}
				};
			});
			const hid = {
				async requestDevice(request: { filters: HidFilter[] }) {
					log.requests.push({ filters: request.filters.map((filter) => ({ ...filter })) });
					const index = nextDevice++;
					const cable = cables[index];
					if (!cable) return [];
					permitted.add(index);
					return [cable];
				},
				async getDevices() {
					return cables.filter((_, index) => permitted.has(index));
				},
				addEventListener: events.addEventListener.bind(events),
				removeEventListener: events.removeEventListener.bind(events)
			};
			Object.defineProperty(navigator, 'hid', { value: hid, configurable: true });
		},
		{
			devices: options.devices ?? 1,
			disconnectAtReport: options.disconnectAtReport ?? null,
			disconnectDevice: options.disconnectDevice ?? 0,
			absent: options.absent ?? false,
			recordTimers: options.recordTimers ?? false
		}
	);
}

export async function hidLog(page: Page): Promise<HidLog> {
	return page.evaluate(() => (globalThis as StubWindow).__bHid);
}
