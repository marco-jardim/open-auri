import { vi } from 'vitest';
import type { AudioEngineState } from '#lib/audio/engine.ts';
import type { PlaybackEngine } from '#lib/components/chrome/playback.ts';

export function createPlaybackEngine(initial: Partial<AudioEngineState> = {}) {
	let state: AudioEngineState = {
		mode: 'chains',
		playing: true,
		ready: true,
		rate: 96_000,
		exact: true,
		note: null,
		volumeDb: -18,
		error: null,
		persisted: true,
		source: 'noise',
		file: null,
		position: 0,
		duration: null,
		paused: false,
		loop: true,
		session: 'curva',
		canToggle: true,
		toggleReason: null,
		...initial
	};
	const listeners = new Set<(state: AudioEngineState) => void>();
	const togglePlayback = vi.fn<PlaybackEngine['togglePlayback']>().mockResolvedValue('paused');
	const engine: PlaybackEngine = {
		state: () => state,
		onChange: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		togglePlayback
	};
	return {
		engine,
		togglePlayback,
		listeners,
		setState(patch: Partial<AudioEngineState>) {
			state = { ...state, ...patch };
			for (const listener of listeners) listener(state);
		}
	};
}
