import { m } from '#lib/paraglide/messages.js';
import type { AudioEngine } from '#lib/audio/engine.ts';

/** Only the existing preview's transport; importing this never loads the audio runtime. */
export type PlaybackEngine = Pick<AudioEngine, 'state' | 'onChange' | 'togglePlayback'>;
export type PlaybackErrorHandler = (message: string) => void;

/** A gesture may continue a page-created session, never create one from the bar. */
export async function togglePreview(
	engine: PlaybackEngine | undefined,
	onError?: PlaybackErrorHandler
): Promise<void> {
	if (!engine?.state().canToggle) return;
	if ((await engine.togglePlayback()) !== 'failed') return;
	const error = engine.state().error;
	const message =
		error === 'gesture'
			? m.audio_error_gesture()
			: error === 'suspended'
				? m.audio_error_suspended()
				: error === 'tab-hidden'
					? m.audio_error_tab_hidden()
					: error === 'unsupported'
						? m.transport_toggle_unsupported()
						: m.layout_error_generic();
	onError?.(message);
}
