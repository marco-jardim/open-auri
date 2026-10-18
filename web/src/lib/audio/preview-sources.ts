import type { AudioEngine } from './engine.ts';

export interface PreviewTitle {
	'pt-BR': string;
	'en-US': string;
}

export interface PreviewSection {
	id: string;
	title: PreviewTitle;
	start: number;
	end: number;
}

export interface PreviewSource {
	id: string;
	filename: string;
	title: PreviewTitle;
	duration: number;
	sections: PreviewSection[];
}

export const AUDIO_SOURCE_KEY = 'oa.audio.source';
export type AudioSourceChoice = 'noise' | 'file' | `builtin:${string}`;

/** Start-inclusive, end-exclusive, matching the manifest, including its silence sections. */
export function sectionAtTime(
	sections: readonly PreviewSection[],
	seconds: number
): PreviewSection | null {
	if (!Number.isFinite(seconds) || seconds < 0) return null;
	return sections.find(({ start, end }) => seconds >= start && seconds < end) ?? null;
}

export function previewFilename(source: PreviewSource): string {
	return source.filename.replace(/\.wav$/i, '.mp3');
}

export function previewAudioUrl(source: PreviewSource, base = ''): string {
	return `${base}/audio/preview/${previewFilename(source)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isTitle(value: unknown): value is PreviewTitle {
	return (
		isRecord(value) && typeof value['pt-BR'] === 'string' && typeof value['en-US'] === 'string'
	);
}

function isSection(value: unknown): value is PreviewSection {
	return (
		isRecord(value) &&
		typeof value.id === 'string' &&
		isTitle(value.title) &&
		typeof value.start === 'number' &&
		Number.isFinite(value.start) &&
		value.start >= 0 &&
		typeof value.end === 'number' &&
		Number.isFinite(value.end) &&
		value.end > value.start
	);
}

function isSource(value: unknown): value is PreviewSource {
	return (
		isRecord(value) &&
		typeof value.id === 'string' &&
		typeof value.filename === 'string' &&
		/^[a-z0-9-]+\.wav$/i.test(value.filename) &&
		isTitle(value.title) &&
		typeof value.duration === 'number' &&
		Number.isFinite(value.duration) &&
		value.duration > 0 &&
		Array.isArray(value.sections) &&
		value.sections.every(isSection)
	);
}

/** Metadata is small but still fetched on demand; no recordings enter the JS bundle. */
export async function fetchPreviewSources(
	base = '',
	signal?: AbortSignal
): Promise<PreviewSource[]> {
	const response = await fetch(`${base}/audio/preview/manifest.json`, { signal });
	if (!response.ok) throw new Error(`Preview manifest: HTTP ${response.status}`);
	const manifest: unknown = await response.json();
	if (!isRecord(manifest) || !Array.isArray(manifest.files) || !manifest.files.every(isSource)) {
		throw new Error('Invalid preview manifest');
	}
	return manifest.files;
}

/** Same validation, streaming decode, loop and gain path as a user-picked file. */
export async function loadPreviewSource(
	engine: Pick<AudioEngine, 'loadFile'>,
	source: PreviewSource,
	base = '',
	signal?: AbortSignal
): Promise<void> {
	const response = await fetch(previewAudioUrl(source, base), { signal });
	if (!response.ok) throw new Error(`Preview audio: HTTP ${response.status}`);
	const blob = await response.blob();
	signal?.throwIfAborted();
	await engine.loadFile(new File([blob], previewFilename(source), { type: 'audio/mpeg' }));
}

/** Only the choice is stored here. User file storage stays entirely with the existing engine. */
export function readAudioSource(): AudioSourceChoice | null {
	try {
		const value = localStorage.getItem(AUDIO_SOURCE_KEY);
		return value === 'noise' || value === 'file' || /^builtin:[a-z0-9-]+$/.test(value ?? '')
			? (value as AudioSourceChoice)
			: null;
	} catch {
		return null;
	}
}

export function rememberAudioSource(choice: AudioSourceChoice): void {
	try {
		localStorage.setItem(AUDIO_SOURCE_KEY, choice);
	} catch {
		// Playback still works when browser storage is unavailable.
	}
}
