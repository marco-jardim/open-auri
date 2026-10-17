import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { NEUTRO } from 'open-auri/catalog';
import { encodeS1 } from 'open-auri/share';
import { createClientApp, type ClientApp } from '#lib/app/index.ts';
import { createAudioEngine, type AudioEngine } from '#lib/audio/engine.ts';
import {
	createSocialSession,
	ORIGINS_KEY,
	rememberOrigin,
	SOCIAL_OUTBOX_TYPE
} from '#lib/social/index.ts';
import SocialActions from '#lib/components/pages/curva/SocialActions.svelte';
import { CurvaPreview } from '#lib/components/pages/curva/preview.svelte.ts';
import { curvaSocialApi, PreviewActivity } from '#lib/components/pages/curva/social.ts';
import { fakeAppOptions } from '../../app/fakes.ts';
import { audioConfig, fakeEnv, resetAudioConfig } from '../../audio/fake-audio.ts';

const curve = { bands: NEUTRO.bands, preampDb: NEUTRO.preampDb };
const s1 = encodeS1(curve);
const origin = { lineageId: 'audible', versionId: 'v1', at: 0 };
const apps: ClientApp[] = [];
const engines: AudioEngine[] = [];
const previews: CurvaPreview[] = [];

afterEach(async () => {
	await cleanup();
	for (const preview of previews.splice(0)) preview.dispose();
	for (const app of apps.splice(0)) app.dispose();
	for (const engine of engines.splice(0)) await engine.dispose();
	vi.useRealTimers();
	vi.restoreAllMocks();
	localStorage.removeItem(ORIGINS_KEY);
});

test('only ten continuous audible seconds produce one event per user-started session', () => {
	const activity = new PreviewActivity();
	for (let n = 0; n < 100; n++) expect(activity.sample(1, s1, origin, n / 10)).toBeNull();
	expect(activity.sample(1, s1, origin, 10)).toEqual({
		kind: 'previewed',
		lineageId: 'audible',
		durationMs: 10_000
	});
	for (let n = 101; n < 300; n++) expect(activity.sample(1, s1, origin, n / 10)).toBeNull();
	for (let n = 0; n < 100; n++) expect(activity.sample(2, s1, origin, n / 10)).toBeNull();
	expect(activity.sample(2, s1, origin, 10)).not.toBeNull();
});

test('silence, paused time, unknown origin, edits and scheduling gaps never accumulate', () => {
	const activity = new PreviewActivity();
	for (let n = 0; n < 90; n++) activity.sample(1, s1, origin, n / 10);
	expect(activity.sample(1, s1, origin, null)).toBeNull();
	for (let n = 90; n < 180; n++) expect(activity.sample(1, s1, origin, n / 10)).toBeNull();
	for (let n = 180; n < 400; n++) expect(activity.sample(1, s1, null, n / 10)).toBeNull();
	for (let n = 400; n < 490; n++) expect(activity.sample(1, s1, origin, n / 10)).toBeNull();
	for (let n = 490; n < 580; n++) {
		expect(activity.sample(1, 'edited-bytes', origin, n / 10)).toBeNull();
	}
	expect(activity.sample(1, 'edited-bytes', origin, 100)).toBeNull();
	activity.interrupt();
	for (let n = 1000; n < 1090; n++) {
		expect(activity.sample(1, 'edited-bytes', origin, n / 10)).toBeNull();
	}
});

test('the audio guard needs PCM, B side, monitor gain and a running context', async () => {
	resetAudioConfig();
	const engine = createAudioEngine(fakeEnv(null).env);
	engines.push(engine);
	const createAB = vi.spyOn(engine, 'createAB');
	const preview = new CurvaPreview(engine);
	previews.push(preview);
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	await preview.start(curve, curve);
	const analyser = preview.analyser;
	const context = audioConfig.instances[0];
	const result = createAB.mock.results[0];
	const ab = result?.type === 'return' ? result.value : null;
	if (!analyser || !context || !ab) throw new Error('Preview not initialized');
	let pcm = 0;
	Object.assign(analyser, { getFloatTimeDomainData: (samples: Float32Array) => samples.fill(pcm) });
	expect(preview.audibleEditorTime()).toBeNull();
	pcm = 0.2;
	expect(preview.audibleEditorTime()).toBe(context.currentTime);
	ab.b.volume.gain.setValueAtTime(0, context.currentTime);
	expect(preview.audibleEditorTime()).toBeNull();
	ab.b.volume.gain.setValueAtTime(1, context.currentTime);
	preview.select('A');
	expect(preview.audibleEditorTime()).toBeNull();
	preview.select('B');
	context.state = 'suspended';
	expect(preview.audibleEditorTime()).toBeNull();
	context.state = 'running';
	preview.stop();
	expect(preview.audibleEditorTime()).toBeNull();
});

async function listenOnCurva(
	session: ReturnType<typeof createSocialSession>,
	fetcher: (input: string, init: RequestInit) => Promise<Response>
) {
	await rememberOrigin({ s1, lineageId: origin.lineageId, versionId: origin.versionId });
	const app = createClientApp(fakeAppOptions().options);
	apps.push(app);
	await app.state.ready;
	const preview = new CurvaPreview(app.audio);
	previews.push(preview);
	preview.playing = true;
	preview.session = 1;
	let seconds: number | null = null;
	vi.spyOn(preview, 'audibleEditorTime').mockImplementation(() => seconds);
	vi.useFakeTimers();
	const screen = await render(SocialActions, {
		app,
		curve,
		name: 'Editor',
		locale: 'pt-BR',
		pageUrl: new URL('https://example.test/'),
		preview,
		api: curvaSocialApi(fetcher),
		session
	});
	await vi.waitFor(() =>
		expect(screen.container.querySelector('a[href="/c/audible"]')).not.toBeNull()
	);
	return {
		app,
		async play(from: number, to: number) {
			for (let n = from; n <= to; n++) {
				seconds = n / 10;
				await vi.advanceTimersByTimeAsync(100);
			}
		},
		async silence(ms: number) {
			seconds = null;
			await vi.advanceTimersByTimeAsync(ms);
		}
	};
}

test('Curva never stores a signed-out preview (nothing waits for a later account)', async () => {
	const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
	const listen = await listenOnCurva(createSocialSession({ initial: null }), fetcher);
	await listen.play(0, 250);
	await tick();
	expect(await listen.app.state.outbox.list()).toHaveLength(0);
	expect(fetcher).not.toHaveBeenCalled();
});

test('Curva queues a verified listener preview through the outbox, stamped with the account', async () => {
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	// The API is down (503): the event stays queued and nothing is posted to /curves/[id]/activity.
	const fetcher = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(
		async () => new Response('', { status: 503 })
	);
	const listen = await listenOnCurva(
		createSocialSession({ initial: { id: 'u-ana', username: 'Ana', emailVerified: true } }),
		fetcher
	);
	await listen.play(0, 90);
	await listen.silence(20_000);
	expect(await listen.app.state.outbox.list()).toHaveLength(0);
	await listen.play(0, 100);
	await tick();
	await vi.waitFor(async () => expect(await listen.app.state.outbox.list()).toHaveLength(1));
	const events = await listen.app.state.outbox.list();
	expect(events[0]).toMatchObject({
		type: SOCIAL_OUTBOX_TYPE,
		payload: { owner: 'u-ana', kind: 'previewed', lineageId: 'audible', durationMs: 10_000 }
	});
	await listen.play(101, 250);
	expect(await listen.app.state.outbox.list()).toHaveLength(1);
	const urls = fetcher.mock.calls.map(([input]) => input);
	expect(urls.some((url) => /\/curves\/[^/]+\/activity/.test(url))).toBe(false);
});
