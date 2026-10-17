import { expect, type Page } from '@playwright/test';
import type { MeterFrame, MeterKind, PpmType } from '../../../src/lib/audio/meters';
import { startPreview } from './c-audio';

export interface SignalOptions {
	sampleRate?: number;
	seconds?: number;
	frequency?: number;
	dbfs?: number;
	phase?: number;
	channels?: 1 | 2;
	inverted?: boolean;
	silence?: boolean;
	burstSeconds?: number;
	kinds?: MeterKind[];
	ppmType?: PpmType;
}

export interface TimedMeterFrame extends MeterFrame {
	/** End of the actual render quantum, read inside AudioWorkletGlobalScope. */
	seconds: number;
}

// A test-only blob module: AudioWorklet fetches did not reach page.route in the built-app run.
// Only the offline tests enable bypassCSP; the app's own worklet still loads from its real URL.
const CLOCK_MODULE = `const nativeRegister = globalThis.registerProcessor.bind(globalThis);
globalThis.registerProcessor = (name, Processor) => {
	if (name !== 'oa-meter') return nativeRegister(name, Processor);
	nativeRegister(name, class extends Processor {
		constructor(options) {
			super(options);
			this.cFrames = options.processorOptions.cRenderFrames;
			this.cPost = this.port.postMessage.bind(this.port);
			this.port.postMessage = (frame) => this.cPost({
				type: 'frame', frame, endFrame: currentFrame + 128
			});
		}
		process(inputs, outputs, parameters) {
			const keepAlive = super.process(inputs, outputs, parameters);
			if (currentFrame + 128 >= this.cFrames) this.cPost({ type: 'complete' });
			return keepAlive;
		}
	});
};`;

/** Discover the production-bundled URL through the real UI, not a dev-only source path. */
export async function meterModuleUrl(page: Page): Promise<string> {
	await startPreview(page);
	await expect
		.poll(() => page.evaluate(() => window.__cAudio.workletUrls.length))
		.toBeGreaterThan(0);
	// Seeing the URL alone does not prove addModule succeeded or that frames reached the UI.
	await expect(page.locator('.ps-out .meter')).toHaveAttribute('data-mode', 'live');
	const url = await page.evaluate(() => window.__cAudio.workletUrls[0]);
	if (!url) throw new Error('The page did not load its meter worklet');
	await page.locator('.preview-row button.bat').click();
	await expect(page.locator('.preview-row button.bat')).toHaveAttribute('aria-pressed', 'false');
	return url;
}

/**
 * Run the shipped processor in Chromium, with real 128-frame render quanta and MessagePorts.
 * The shim only envelopes the original messages with currentFrame; no DSP is replaced or copied.
 * A final FIFO marker makes collecting frames deterministic even when offline rendering is fast.
 */
export async function renderMeters(page: Page, moduleUrl: string, options: SignalOptions = {}) {
	return page.evaluate(
		async ({ moduleUrl, options, clockSource }) => {
			const sampleRate = options.sampleRate ?? 48000;
			const seconds = options.seconds ?? 2;
			const frameCount = Math.ceil((seconds * sampleRate) / 128) * 128;
			const context = new OfflineAudioContext(2, frameCount, sampleRate);
			const clockUrl = URL.createObjectURL(new Blob([clockSource], { type: 'text/javascript' }));
			try {
				await context.audioWorklet.addModule(clockUrl);
			} catch (cause) {
				throw new Error(`Offline meter clock module failed to load: ${String(cause)}`, { cause });
			} finally {
				URL.revokeObjectURL(clockUrl);
			}
			try {
				await context.audioWorklet.addModule(moduleUrl);
			} catch (cause) {
				throw new Error(`Offline app worklet failed to load (${moduleUrl}): ${String(cause)}`, {
					cause
				});
			}
			const meter = new AudioWorkletNode(context, 'oa-meter', {
				numberOfInputs: 1,
				numberOfOutputs: 0,
				channelCount: 2,
				channelCountMode: 'explicit',
				channelInterpretation: 'speakers',
				processorOptions: {
					kinds: options.kinds ?? ['vu', 'ppm', 'truePeak', 'correlation'],
					reference: -18,
					ppmType: options.ppmType ?? 'II',
					cRenderFrames: frameCount
				}
			});
			const frames: TimedMeterFrame[] = [];
			let timer: ReturnType<typeof setTimeout> | undefined;
			const complete = new Promise<void>((resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error('Offline meter did not finish publishing')),
					10000
				);
				meter.onprocessorerror = () => reject(new Error('oa-meter processorerror'));
				meter.port.onmessage = (event: MessageEvent<unknown>) => {
					if (typeof event.data !== 'object' || event.data === null) {
						reject(new Error('Invalid worklet envelope'));
						return;
					}
					const data = event.data as { type?: string; frame?: MeterFrame; endFrame?: number };
					if (data.type === 'complete') {
						resolve();
						return;
					}
					const frame = data.frame;
					if (
						data.type !== 'frame' ||
						!frame ||
						typeof frame.active !== 'boolean' ||
						typeof data.endFrame !== 'number' ||
						![
							frame.vuL,
							frame.vuR,
							frame.ppmL,
							frame.ppmR,
							frame.truePeakDb,
							frame.lufsM,
							frame.lufsS,
							frame.correlation
						].every(Number.isFinite)
					) {
						reject(new Error('Invalid native meter frame'));
						return;
					}
					frames.push({ ...frame, seconds: data.endFrame / sampleRate });
				};
			});
			const channels = options.channels ?? 2;
			const buffer = context.createBuffer(channels, frameCount, sampleRate);
			const frequency = options.frequency ?? 1000;
			const amplitude = options.silence ? 0 : 10 ** ((options.dbfs ?? -18) / 20);
			const phase = options.phase ?? 0;
			const toneFrames = Math.min(
				frameCount,
				Math.round((options.burstSeconds ?? seconds) * sampleRate)
			);
			let samplePeak = 0;
			for (let channel = 0; channel < channels; channel++) {
				const samples = buffer.getChannelData(channel);
				const sign = channel === 1 && options.inverted ? -1 : 1;
				for (let i = 0; i < toneFrames; i++) {
					samples[i] =
						sign * amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate + phase);
					samplePeak = Math.max(samplePeak, Math.abs(samples[i]));
				}
			}
			const source = context.createBufferSource();
			source.buffer = buffer;
			source.connect(meter);
			// Also pull the source through a silent output; analysis must not depend on audible output.
			const silent = context.createGain();
			silent.gain.value = 0;
			source.connect(silent).connect(context.destination);
			source.start(0);
			try {
				await Promise.all([context.startRendering(), complete]);
				return {
					frames,
					sampleRate: context.sampleRate,
					samplePeakDb: samplePeak === 0 ? -120 : 20 * Math.log10(samplePeak)
				};
			} finally {
				clearTimeout(timer);
				meter.port.close();
				source.disconnect();
				meter.disconnect();
				silent.disconnect();
			}
		},
		{ moduleUrl, options, clockSource: CLOCK_MODULE }
	);
}

export async function idleMeterMutations(page: Page): Promise<{ count: number; elements: number }> {
	return page.evaluate(async () => {
		const meters = document.querySelectorAll('main [data-mode]');
		if (meters.length === 0) throw new Error('No meter elements to observe');
		let count = 0;
		const observer = new MutationObserver((records) => {
			count += records.length;
		});
		for (const meter of meters) {
			observer.observe(meter, {
				attributes: true,
				childList: true,
				characterData: true,
				subtree: true
			});
		}
		// This is the measured acceptance window, not a sleep used to synchronise an action.
		await new Promise((resolve) => setTimeout(resolve, 2000));
		count += observer.takeRecords().length;
		observer.disconnect();
		return { count, elements: meters.length };
	});
}
