<!--
	Preview-audio panel of the top-bar "♪ Áudio" trigger (FUX.2: its own chunk, imported on the
	trigger's first hover, focus or press). Load (file input or drag and drop), name, duration,
	transport (SEEK.1: seek bar, back to start, play/pause; it continues a page's paused preview,
	else plays the file raw from where it is), preview volume, 0 VU reference, remove. The file
	never leaves the browser. The trigger (AudioLoader) owns the engine subscription, the open
	state and the placement.
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import {
		AudioEngineError,
		MAX_FILE_BYTES,
		MAX_VOLUME_DB,
		MIN_VOLUME_DB,
		type AudioEngine,
		type AudioEngineState,
		type AudioErrorCode
	} from '#lib/audio/engine.ts';
	import { VuReferenceSelect, type VuReferenceStore } from '#lib/components/meters/index.ts';
	import Transport from './Transport.svelte';

	/** Session tag of the panel's own raw playback. */
	const PANEL_SESSION = 'audio-panel';

	interface Props {
		engine: AudioEngine;
		/** Engine state, from the trigger's single subscription. */
		state: AudioEngineState;
		open: boolean;
		ids: { dialog: string; title: string; volume: string };
		pos: { top: number; left: number } | null;
		referenceStore: VuReferenceStore | null;
		dialog?: HTMLDivElement;
	}

	let { engine, state: s, open, ids, pos, referenceStore, dialog = $bindable() }: Props = $props();

	let dragging = $state(false);
	let rejected = $state<AudioErrorCode | null>(null);
	const errorCode = $derived(rejected ?? s.error);

	function fmtDb(db: number): string {
		return `${db < 0 ? '−' : ''}${Math.abs(db)} dB`;
	}

	function fmtDuration(seconds: number): string {
		if (!Number.isFinite(seconds)) return '…';
		const total = Math.floor(seconds);
		return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
	}

	function fmtSize(bytes: number): string {
		const mb = new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 }).format(
			bytes / 1048576
		);
		return `${mb} MB`;
	}

	function rateText(state: AudioEngineState): string {
		if (!state.ready) return m.audio_rate_idle();
		if (state.exact) return m.audio_rate_exact();
		return m.audio_rate_approx({ rate: new Intl.NumberFormat(getLocale()).format(state.rate) });
	}

	function errorText(code: AudioErrorCode): string {
		switch (code) {
			case 'invalid-file':
				return m.audio_error_invalid();
			case 'too-large':
				return m.audio_error_too_large({ limit: String(MAX_FILE_BYTES / 1048576) });
			case 'decode':
				return m.audio_error_decode();
			case 'suspended':
				return m.audio_error_suspended();
			case 'gesture':
				return m.audio_error_gesture();
			case 'tab-hidden':
				return m.audio_error_tab_hidden();
			case 'unsupported':
				return m.audio_error_unsupported();
		}
	}

	function codeOf(error: unknown, fallback: AudioErrorCode): AudioErrorCode {
		return error instanceof AudioEngineError ? error.code : fallback;
	}

	async function useFile(file: File | null | undefined): Promise<void> {
		if (!file) return;
		rejected = null;
		try {
			await engine.loadFile(file);
		} catch (error) {
			rejected = codeOf(error, 'invalid-file');
		}
	}

	function onFileChange(event: Event & { currentTarget: HTMLInputElement }): void {
		const input = event.currentTarget;
		const file = input.files?.[0];
		input.value = '';
		void useFile(file);
	}

	/** Transport `onplay`: nothing paused to continue, so play the file raw (a user click). */
	async function playRaw(): Promise<void> {
		rejected = null;
		await engine.start('raw', { session: PANEL_SESSION });
	}

	function onTransportError(error: unknown): void {
		rejected = codeOf(error, 'suspended');
	}

	// Playback that started (here, on a page or from the navbar) clears a stale refusal.
	$effect(() => {
		if (s.playing) rejected = null;
	});

	function removeFile(): void {
		rejected = null;
		void engine.removeFile();
	}

	function onVolume(event: Event & { currentTarget: HTMLInputElement }): void {
		engine.setVolume(Number(event.currentTarget.value));
	}

	/** Drag and drop is a shortcut; the file input stays the keyboard-accessible path. */
	function dropZone(node: HTMLElement): () => void {
		const over = (event: DragEvent) => {
			event.preventDefault();
			dragging = true;
		};
		const leave = () => {
			dragging = false;
		};
		const drop = (event: DragEvent) => {
			event.preventDefault();
			dragging = false;
			void useFile(event.dataTransfer?.files[0]);
		};
		node.addEventListener('dragover', over);
		node.addEventListener('dragleave', leave);
		node.addEventListener('drop', drop);
		return () => {
			node.removeEventListener('dragover', over);
			node.removeEventListener('dragleave', leave);
			node.removeEventListener('drop', drop);
		};
	}
</script>

<div
	class="oa-audio-pop"
	id={ids.dialog}
	role="dialog"
	aria-labelledby={ids.title}
	tabindex="-1"
	hidden={!open}
	style:top={pos ? `${pos.top}px` : null}
	style:left={pos ? `${pos.left}px` : null}
	bind:this={dialog}
>
	<h3 id={ids.title}>{m.audio_title()}</h3>

	<div class="oa-audio-drop" class:dragging {@attach dropZone}>
		<label class="oa-audio-load">
			<span>{m.audio_load()}</span>
			<input
				type="file"
				class="oa-audio-file"
				accept="audio/mpeg,audio/mp3,audio/*"
				onchange={onFileChange}
			/>
		</label>
		<span class="oa-audio-drop-hint">{m.audio_drop()}</span>
	</div>

	<div class="oa-audio-meta" aria-live="polite">
		{#if s.file}
			<b>{s.file.name}</b> · {fmtDuration(s.file.duration)} · {fmtSize(s.file.size)}
		{:else}
			{m.audio_none()}
		{/if}
	</div>

	{#if errorCode}
		<p class="oa-audio-error" role="alert">{errorText(errorCode)}</p>
	{/if}
	{#if s.file && !s.persisted}
		<p class="oa-audio-warn">{m.audio_not_saved()}</p>
	{/if}

	<div class="oa-audio-row">
		<!-- Play stays the row's first button and keeps its name (the e2e flows rely on both). -->
		<div class="oa-audio-transport">
			<Transport
				{engine}
				state={s}
				variant="full"
				onplay={playRaw}
				startLabel={m.audio_play()}
				playDisabledReason={s.file ? null : m.transport_reason_no_file()}
				onerror={onTransportError}
			/>
		</div>
		<button type="button" disabled={!s.file} onclick={removeFile}>{m.audio_remove()}</button>
	</div>

	<div class="oa-audio-vol">
		<label for={ids.volume}>{m.audio_volume()}</label>
		<output for={ids.volume}>{fmtDb(s.volumeDb)}</output>
		<input
			id={ids.volume}
			type="range"
			min={MIN_VOLUME_DB}
			max={MAX_VOLUME_DB}
			step="1"
			value={s.volumeDb}
			aria-valuetext={fmtDb(s.volumeDb)}
			oninput={onVolume}
		/>
	</div>

	{#if referenceStore}
		<VuReferenceSelect store={referenceStore} />
	{/if}

	<p class="oa-audio-rate" class:approx={s.ready && !s.exact}>{rateText(s)}</p>
	<p class="oa-audio-note">{m.audio_note()}</p>
</div>

<style>
	.oa-audio-pop {
		position: fixed;
		z-index: 80;
		width: 320px;
		max-width: calc(100vw - 24px);
		background: #1b1b19;
		border: 1px solid #34332f;
		border-radius: 6px;
		padding: 14px;
		box-shadow: 0 18px 40px rgba(0, 0, 0, 0.65);
		font-size: 12px;
		line-height: 1.45;
		color: var(--oa-text);
		white-space: normal;
	}
	.oa-audio-pop[hidden] {
		display: none;
	}
	.oa-audio-pop:focus-visible,
	.oa-audio-pop button:focus-visible,
	.oa-audio-pop input[type='range']:focus-visible {
		outline: 2px solid var(--oa-accent);
		outline-offset: 3px;
	}
	h3 {
		margin: 0 0 10px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--oa-muted);
	}
	.oa-audio-drop {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		padding: 6px;
		border: 1px dashed transparent;
		border-radius: 4px;
	}
	.oa-audio-drop.dragging {
		border-color: var(--oa-accent);
	}
	.oa-audio-drop-hint {
		font-size: 11px;
		color: var(--oa-muted);
	}
	.oa-audio-load {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		border: 1px solid var(--oa-accent);
		color: var(--oa-accent);
		border-radius: 3px;
		padding: 7px 10px;
		cursor: pointer;
		font-size: 12px;
	}
	.oa-audio-load:focus-within {
		outline: 2px solid var(--oa-accent);
		outline-offset: 3px;
	}
	.oa-audio-file {
		position: absolute;
		inset: 0;
		opacity: 0;
		width: 100%;
		height: 100%;
		cursor: pointer;
	}
	.oa-audio-meta {
		margin: 10px 0;
		font-size: 11px;
		line-height: 1.5;
		color: #cfc9be;
		word-break: break-word;
	}
	.oa-audio-meta b {
		color: var(--oa-text);
		font-weight: 500;
	}
	.oa-audio-error,
	.oa-audio-warn {
		margin: 0 0 10px;
		font-size: 11px;
		color: color-mix(in srgb, var(--oa-accent) 40%, white);
	}
	.oa-audio-transport {
		flex: 1 1 100%;
		min-width: 0;
		margin: 0 0 4px;
	}
	.oa-audio-row {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}
	.oa-audio-row button {
		border: 1px solid var(--oa-rule);
		background: transparent;
		color: inherit;
		border-radius: 3px;
		padding: 6px 10px;
		font-size: 11.5px;
	}
	.oa-audio-row button:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.oa-audio-vol {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 4px 10px;
		align-items: center;
		margin-top: 12px;
		font-size: 11.5px;
		color: #cfc9be;
	}
	.oa-audio-vol input {
		grid-column: 1 / -1;
		width: 100%;
		accent-color: var(--oa-accent);
	}
	.oa-audio-vol output {
		font-size: 11px;
		color: var(--oa-accent);
	}
	.oa-audio-rate {
		margin: 6px 0 0;
		font-size: 10.5px;
		color: var(--oa-muted);
	}
	.oa-audio-rate.approx {
		color: color-mix(in srgb, var(--oa-accent) 40%, white);
	}
	.oa-audio-note {
		margin: 10px 0 0;
		font-size: 11px;
		color: var(--oa-muted);
	}
	@media (max-width: 720px) {
		.oa-audio-pop {
			position: fixed;
			left: 12px;
			right: 12px;
			top: 118px;
			width: auto;
			max-width: none;
		}
	}
</style>
