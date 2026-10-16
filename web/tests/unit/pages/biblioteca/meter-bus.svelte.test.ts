import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render } from 'vitest-browser-svelte';
import { createClientApp, type ClientApp } from '#lib/app/client.svelte.ts';
import { createAudioEngine } from '#lib/audio/engine.ts';
import type { MeterUpdate } from '#lib/audio/meters.ts';
import Biblioteca from '#lib/components/pages/biblioteca/Biblioteca.svelte';

const { fakeTap } = vi.hoisted(() => ({ fakeTap: vi.fn() }));
vi.mock('#lib/audio/meters.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/audio/meters.ts')>()),
	tap: fakeTap
}));

let app: ClientApp | null = null;
afterEach(async () => {
	await cleanup();
	app?.dispose();
	await app?.audio.dispose();
	app = null;
	fakeTap.mockReset();
	vi.restoreAllMocks();
});

test('the archive meters tap the pre-volume meter bus, never the post-volume output', async () => {
	fakeTap.mockImplementation(async () => ({
		disconnect: vi.fn(),
		setReference: vi.fn(),
		subscribe: (listener: (update: MeterUpdate) => void) => {
			listener({ mode: 'data', frame: null });
			return () => undefined;
		}
	}));
	app = createClientApp({
		storage: { local: null, session: null, indexedDB: null, channel: null },
		audio: createAudioEngine({ indexedDB: null })
	});
	await app.state.ready;
	app.state.meterRef.set(-14);
	// The context exists (as after any Play); no audio is started here.
	app.audio.getContext();
	await render(Biblioteca, { app, origin: 'https://example.test' });
	await expect.poll(() => fakeTap.mock.calls.length).toBeGreaterThan(0);
	const [node, options] = fakeTap.mock.calls.at(-1) ?? [];
	expect(node).toBe(app.audio.getMeterBus());
	expect(node).not.toBe(app.audio.getAnalyserTap());
	expect(options).toMatchObject({ reference: -14 });
	expect(app.audio.state().playing).toBe(false);
});
