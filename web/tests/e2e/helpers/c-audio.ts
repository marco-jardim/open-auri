import { expect, type Page } from '@playwright/test';
import { createWav } from '../../../scripts/gen-fixtures.mjs';

export const AUDIO_FILE_NAME = 'sine-440hz-minus18dbfs.wav';

export interface AudioSnapshot {
	contexts: { requestedRate: number | null; sampleRate: number; state: AudioContextState }[];
	mediaSources: number;
	mediaDisconnections: number;
	iirs: { id: number; feedforward: number[]; feedback: number[] }[];
	edges: { from: number; to: number }[];
	ramps: { node: number; value: number; time: number }[];
	gains: { id: number; value: number }[];
	buffers: { started: boolean; loop: boolean; channels: number; frames: number; peak: number }[];
}

declare global {
	interface Window {
		/** Installed by the spec before app code, not an application debug API. */
		__cAudio: { read(): AudioSnapshot; workletUrls: string[] };
	}
}

/** Observe native APIs without replacing audio, coefficients, scheduling or worklet messages. */
export async function installAudioProbe(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const contexts: { context: AudioContext; requestedRate: number | null }[] = [];
		const iirs: AudioSnapshot['iirs'] = [];
		const edges: AudioSnapshot['edges'] = [];
		const ramps: AudioSnapshot['ramps'] = [];
		const gains = new Map<number, GainNode>();
		const buffers: { node: AudioBufferSourceNode; started: boolean }[] = [];
		const owners = new WeakMap<AudioParam, number>();
		const ids = new WeakMap<AudioNode, number>();
		const workletUrls: string[] = [];
		let sequence = 0;
		let mediaSources = 0;
		let mediaDisconnections = 0;
		function id(node: AudioNode): number {
			let value = ids.get(node);
			if (value === undefined) {
				value = ++sequence;
				ids.set(node, value);
			}
			return value;
		}

		const NativeContext = window.AudioContext;
		window.AudioContext = class extends NativeContext {
			constructor(options?: AudioContextOptions) {
				super(options);
				contexts.push({ context: this, requestedRate: options?.sampleRate ?? null });
				const addModule = this.audioWorklet.addModule.bind(this.audioWorklet);
				this.audioWorklet.addModule = (url, moduleOptions) => {
					workletUrls.push(new URL(String(url), location.href).href);
					return addModule(url, moduleOptions);
				};
			}
		};

		const createIIR = BaseAudioContext.prototype.createIIRFilter;
		BaseAudioContext.prototype.createIIRFilter = function (feedforward, feedback) {
			const node = createIIR.call(this, feedforward, feedback);
			iirs.push({ id: id(node), feedforward: [...feedforward], feedback: [...feedback] });
			return node;
		};
		const createGain = BaseAudioContext.prototype.createGain;
		BaseAudioContext.prototype.createGain = function () {
			const node = createGain.call(this);
			gains.set(id(node), node);
			owners.set(node.gain, id(node));
			return node;
		};
		const createMedia = NativeContext.prototype.createMediaElementSource;
		NativeContext.prototype.createMediaElementSource = function (element) {
			const node = createMedia.call(this, element);
			mediaSources++;
			return node;
		};
		const createBuffer = BaseAudioContext.prototype.createBufferSource;
		BaseAudioContext.prototype.createBufferSource = function () {
			const node = createBuffer.call(this);
			buffers.push({ node, started: false });
			return node;
		};
		const start = AudioBufferSourceNode.prototype.start;
		AudioBufferSourceNode.prototype.start = function (...args) {
			const entry = buffers.find(({ node }) => node === this);
			if (entry) entry.started = true;
			return Reflect.apply(start, this, args);
		};
		const connect = AudioNode.prototype.connect;
		Object.defineProperty(AudioNode.prototype, 'connect', {
			configurable: true,
			writable: true,
			value: function (this: AudioNode, destination: AudioNode | AudioParam, ...ports: number[]) {
				if (destination instanceof AudioNode) edges.push({ from: id(this), to: id(destination) });
				return Reflect.apply(connect, this, [destination, ...ports]);
			}
		});
		const disconnect = AudioNode.prototype.disconnect;
		Object.defineProperty(AudioNode.prototype, 'disconnect', {
			configurable: true,
			writable: true,
			value: function (this: AudioNode, ...args: unknown[]) {
				if (this instanceof MediaElementAudioSourceNode) mediaDisconnections++;
				return Reflect.apply(disconnect, this, args);
			}
		});
		const linearRamp = AudioParam.prototype.linearRampToValueAtTime;
		AudioParam.prototype.linearRampToValueAtTime = function (value, time) {
			const node = owners.get(this);
			if (node !== undefined) ramps.push({ node, value, time });
			return linearRamp.call(this, value, time);
		};

		window.__cAudio = {
			workletUrls,
			read: () => ({
				contexts: contexts.map(({ context, requestedRate }) => ({
					requestedRate,
					sampleRate: context.sampleRate,
					state: context.state
				})),
				mediaSources,
				mediaDisconnections,
				iirs: [...iirs],
				edges: [...edges],
				ramps: [...ramps],
				gains: [...gains].map(([nodeId, node]) => ({ id: nodeId, value: node.gain.value })),
				buffers: buffers.map(({ node, started }) => {
					let peak = 0;
					const samples = node.buffer?.getChannelData(0);
					if (samples) {
						for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
					}
					return {
						started,
						loop: node.loop,
						channels: node.buffer?.numberOfChannels ?? 0,
						frames: node.buffer?.length ?? 0,
						peak
					};
				})
			})
		};
	});
}

export const audioSnapshot = (page: Page): Promise<AudioSnapshot> =>
	page.evaluate(() => window.__cAudio.read());

export async function openAudio(page: Page) {
	const button = page.locator('.oa-audio-btn');
	await expect(button).toBeEnabled();
	if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
	const popover = page.getByRole('dialog', { name: 'Áudio da prévia', exact: true });
	await expect(popover).toBeVisible();
	return popover;
}

export async function loadSineFile(page: Page): Promise<void> {
	const popover = await openAudio(page);
	await popover.locator('input[type="file"]').setInputFiles({
		name: AUDIO_FILE_NAME,
		mimeType: 'audio/wav',
		buffer: createWav()
	});
	await expect(popover.locator('.oa-audio-meta')).toContainText(AUDIO_FILE_NAME);
	await expect(page.locator('.oa-audio-name')).toHaveText(AUDIO_FILE_NAME);
	await expect(popover.locator('.oa-audio-meta')).toContainText('0:03');
}

export async function startPreview(page: Page): Promise<void> {
	await page.keyboard.press('Escape');
	const play = page.locator('.preview-row button.bat');
	await expect(play).toBeEnabled();
	await play.click();
	await expect(play).toHaveAttribute('aria-pressed', 'true');
}

/** Count connected sections, not merely a total that could hide two wrongly sized chains. */
export function iirChainLengths(snapshot: AudioSnapshot): number[] {
	const ids = new Set(snapshot.iirs.map(({ id }) => id));
	const links = snapshot.edges.filter(({ from, to }) => ids.has(from) && ids.has(to));
	const children = new Map(links.map(({ from, to }) => [from, to]));
	const hasParent = new Set(links.map(({ to }) => to));
	return [...ids]
		.filter((id) => !hasParent.has(id))
		.map((root) => {
			const visited = new Set<number>();
			let next: number | undefined = root;
			while (next !== undefined && !visited.has(next)) {
				visited.add(next);
				next = children.get(next);
			}
			return visited.size;
		});
}
