import { afterEach, expect, test, vi } from 'vitest';
import manifest from '../../../static/audio/preview/manifest.json';
import {
	fetchPreviewSources,
	loadPreviewSource,
	previewAudioUrl,
	sectionAtTime
} from '#lib/audio/preview-sources.ts';

const signals = manifest.files[0];

afterEach(() => vi.restoreAllMocks());

test('section lookup uses start-inclusive, end-exclusive manifest boundaries, including silence', () => {
	for (const section of signals.sections) {
		expect(sectionAtTime(signals.sections, section.start)).toBe(section);
		expect(sectionAtTime(signals.sections, (section.start + section.end) / 2)).toBe(section);
		expect(sectionAtTime(signals.sections, section.end)?.id ?? null).toBe(
			signals.sections.find((next) => next.start === section.end)?.id ?? null
		);
	}
	expect(sectionAtTime(signals.sections, 7)?.title['pt-BR']).toBe('Varredura: 20 Hz a 20 kHz');
	expect(sectionAtTime(signals.sections, 44)?.id).toBe('pink');
	expect(sectionAtTime(signals.sections, 58)?.id).toBe('opposite-phase');
	// A loop is reported by the engine as a new position near zero.
	expect(sectionAtTime(signals.sections, 0)?.id).toBe('reference');
});

test.each([-1, NaN, Infinity, -Infinity, 62, 100])(
	'no section outside the track at %s',
	(seconds) => {
		expect(sectionAtTime(signals.sections, seconds)).toBeNull();
		expect(sectionAtTime([], seconds)).toBeNull();
	}
);

test('metadata is fetched by URL and all nine WAV filenames map to deployed MP3 URLs', async () => {
	const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(manifest));
	const tracks = await fetchPreviewSources('/app');
	expect(tracks).toHaveLength(9);
	expect(fetch).toHaveBeenCalledWith('/app/audio/preview/manifest.json', { signal: undefined });
	for (const track of tracks) {
		expect(previewAudioUrl(track, '/app')).toBe(
			`/app/audio/preview/${track.filename.replace(/\.wav$/, '.mp3')}`
		);
	}
});

test('recordings go through the existing file loader without starting playback', async () => {
	const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('MP3 bytes'));
	const loadFile = vi.fn<(file: File) => Promise<void>>().mockResolvedValue(undefined);
	await loadPreviewSource({ loadFile }, signals, '/app');
	expect(fetch).toHaveBeenCalledWith('/app/audio/preview/test-signals.mp3', { signal: undefined });
	expect(loadFile).toHaveBeenCalledOnce();
	const [file] = loadFile.mock.calls[0];
	expect(file).toBeInstanceOf(File);
	expect(file.name).toBe('test-signals.mp3');
	expect(file.type).toBe('audio/mpeg');
	expect(await file.text()).toBe('MP3 bytes');
});

test('failed downloads never replace the current engine file', async () => {
	vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
	const loadFile = vi.fn<(file: File) => Promise<void>>();
	await expect(loadPreviewSource({ loadFile }, signals)).rejects.toThrow('HTTP 404');
	expect(loadFile).not.toHaveBeenCalled();
	await expect(fetchPreviewSources()).rejects.toThrow('HTTP 404');
});

test('a cancelled selection cannot attach even if a late fetch response arrives', async () => {
	const request = new AbortController();
	vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
		request.abort();
		return new Response('late MP3 bytes');
	});
	const loadFile = vi.fn<(file: File) => Promise<void>>();
	await expect(loadPreviewSource({ loadFile }, signals, '', request.signal)).rejects.toThrow();
	expect(loadFile).not.toHaveBeenCalled();
});

test('invalid metadata and unsafe filenames are rejected', async () => {
	const fetch = vi.spyOn(globalThis, 'fetch');
	for (const value of [null, {}, { files: [{ ...signals, filename: '../test-signals.wav' }] }]) {
		fetch.mockResolvedValueOnce(Response.json(value));
		await expect(fetchPreviewSources()).rejects.toThrow('Invalid preview manifest');
	}
});
