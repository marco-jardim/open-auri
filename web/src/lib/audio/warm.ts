// Audio warm-up (FUX.2, spec §5.4 W3). A play control calls `warmAudio()` on `pointerdown` or
// `keydown` (Enter/Space), before its `click`: the AudioContext is created or resumed and the
// meter worklet module is added while the press is still down, so the click handler starts sound
// at once. Warm-up never plays: no source starts and the engine's master gain stays where it is
// (0 until a page starts playback). Pages wire it with the `warmAudioOnPress` attachment:
//
//   <button {@attach warmAudioOnPress(() => app?.audio)} onclick={play}>Ouvir prévia</button>
//
// On meter pages, `prefetchMeterWorklet()` from an idle callback fetches the worklet at low
// priority so even the first press finds it cached.
import { prefetchUrl } from '#lib/app/warm.ts';
import type { AudioEngine } from './engine.ts';

async function sharedEngine(): Promise<AudioEngine> {
	const { getAudioEngine } = await import('./engine.ts');
	return getAudioEngine();
}

let warming: Promise<boolean> | null = null;

/** Chrome keeps `resume()` pending (never rejecting) without user activation: bound the wait. */
const RESUME_WAIT_MS = 500;

function resumeBounded(context: AudioContext): Promise<void> {
	if (context.state === 'running') return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, RESUME_WAIT_MS);
		context.resume().then(
			() => {
				clearTimeout(timer);
				resolve();
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
}

/**
 * Creates or resumes the engine's AudioContext and loads the meter worklet into it. Concurrent
 * calls share one attempt. Resolves true when the context runs with the worklet loaded, false
 * when audio is unavailable or the browser kept the context suspended (no user activation yet).
 * Never rejects: a failed warm-up only means the click does the work as before.
 */
export function warmAudio(engine?: AudioEngine | null): Promise<boolean> {
	if (typeof window === 'undefined') return Promise.resolve(false);
	if (warming) return warming;
	// `.finally` always runs after this assignment, even when the attempt fails synchronously.
	const attempt = warmOnce(engine ?? null).finally(() => {
		if (warming === attempt) warming = null;
	});
	warming = attempt;
	return attempt;
}

async function warmOnce(engine: AudioEngine | null): Promise<boolean> {
	try {
		const target = engine ?? (await sharedEngine());
		const context = target.getContext();
		await resumeBounded(context);
		const { loadMeterWorklet } = await import('./meters.ts');
		await loadMeterWorklet(context);
		return context.state === 'running';
	} catch (error) {
		console.info('Audio warm-up skipped', error);
		return false;
	}
}

const PRESS_KEYS = new Set(['Enter', ' ', 'Spacebar']);

/**
 * Svelte attachment for a play control: warms audio on the press that precedes the click
 * (primary pointer button, or Enter/Space). `engine` is read at press time (the app engine,
 * once the runtime has loaded; the shared engine otherwise).
 */
export function warmAudioOnPress(
	engine?: () => AudioEngine | null | undefined
): (node: HTMLElement) => () => void {
	return (node) => {
		const press = (event: PointerEvent | KeyboardEvent) => {
			if (event instanceof PointerEvent && event.button !== 0) return;
			if (event instanceof KeyboardEvent && (event.repeat || !PRESS_KEYS.has(event.key))) return;
			void warmAudio(engine?.() ?? null);
		};
		node.addEventListener('pointerdown', press);
		node.addEventListener('keydown', press);
		return () => {
			node.removeEventListener('pointerdown', press);
			node.removeEventListener('keydown', press);
		};
	};
}

/**
 * Idle prefetch of the meter worklet module (pages with meters). Resolves with its URL, or null
 * in SSR. The fetch is a low-priority `<link rel="prefetch">`; nothing is executed.
 */
export async function prefetchMeterWorklet(): Promise<string | null> {
	if (typeof document === 'undefined') return null;
	const { default: url } = await import('./meter-processor.js?worker&url');
	prefetchUrl(url);
	return url;
}
