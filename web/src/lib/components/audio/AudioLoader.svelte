<!--
	Top-bar "♪ Áudio" button with the preview-audio popover: load (file input or drag and drop),
	name, duration, play/pause, preview volume, remove. The file never leaves the browser.
-->
<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import {
		AudioEngineError,
		IDLE_STATE,
		MAX_FILE_BYTES,
		MAX_VOLUME_DB,
		MIN_VOLUME_DB,
		getAudioEngine,
		type AudioEngine,
		type AudioEngineState,
		type AudioErrorCode
	} from '#lib/audio/engine.ts';
	import { getAppContext, type AppContext } from '#lib/app/index.ts';
	import { VuReferenceSelect, type VuReferenceStore } from '#lib/components/meters/index.ts';

	interface Props {
		/** Engine to drive; defaults to the page-wide singleton (created on mount, never during SSR). */
		engine?: AudioEngine;
		/** 0 VU reference store (`app.state.meterRef`); defaults to the app context's, when present. */
		meterRef?: VuReferenceStore | null;
	}

	let { engine: provided, meterRef }: Props = $props();

	/** The layout provides the app context; isolated renders (tests) have none. */
	function optionalAppContext(): AppContext | null {
		try {
			return getAppContext();
		} catch (missing) {
			console.debug('AudioLoader rendered without the app context', missing);
			return null;
		}
	}
	const appContext = optionalAppContext();
	const referenceStore = $derived(meterRef ?? appContext?.client?.state.meterRef ?? null);

	const uid = $props.id();
	const ids = {
		button: `${uid}-button`,
		dialog: `${uid}-dialog`,
		title: `${uid}-title`,
		volume: `${uid}-volume`
	};

	let engine: AudioEngine | null = null;
	let s = $state.raw<AudioEngineState>(IDLE_STATE);
	let open = $state(false);
	let dragging = $state(false);
	let rejected = $state<AudioErrorCode | null>(null);
	let root: HTMLDivElement | undefined = $state();
	let button: HTMLButtonElement | undefined = $state();
	let dialog: HTMLDivElement | undefined = $state();

	const errorCode = $derived(rejected ?? s.error);

	onMount(() => {
		const current = provided ?? getAudioEngine();
		engine = current;
		s = current.state();
		return current.onChange((next) => {
			s = next;
		});
	});

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
		if (!file || !engine) return;
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

	async function togglePlay(): Promise<void> {
		if (!engine) return;
		rejected = null;
		if (s.playing) {
			engine.stop();
			return;
		}
		try {
			await engine.start('raw');
		} catch (error) {
			rejected = codeOf(error, 'suspended');
		}
	}

	function removeFile(): void {
		if (!engine) return;
		rejected = null;
		void engine.removeFile();
	}

	function onVolume(event: Event & { currentTarget: HTMLInputElement }): void {
		engine?.setVolume(Number(event.currentTarget.value));
	}

	// The top bar scrolls horizontally (overflow-x: auto), which also clips vertically: the panel is
	// positioned `fixed` from the button so it is never cut at the bar's height.
	const POP_WIDTH = 320;
	const POP_MARGIN = 12;
	let pos = $state<{ top: number; left: number } | null>(null);

	function place(): void {
		if (!button) return;
		const rect = button.getBoundingClientRect();
		const width = Math.min(POP_WIDTH, window.innerWidth - 2 * POP_MARGIN);
		const left = Math.max(POP_MARGIN, Math.min(rect.left, window.innerWidth - width - POP_MARGIN));
		pos = { top: rect.bottom + 10, left };
	}

	function onWindowResize(): void {
		if (open) place();
	}

	async function setOpen(next: boolean, returnFocus = false): Promise<void> {
		if (next) place();
		open = next;
		if (next) {
			await tick();
			dialog?.focus();
		} else if (returnFocus) {
			button?.focus();
		}
	}

	function onWindowClick(event: MouseEvent): void {
		if (open && root && event.target instanceof Node && !root.contains(event.target)) {
			open = false;
		}
	}

	function onWindowKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape' && open) {
			event.stopPropagation();
			void setOpen(false, true);
		}
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

<svelte:window
	onclick={onWindowClick}
	onkeydown={onWindowKeydown}
	onresize={onWindowResize}
	onscroll={onWindowResize}
/>

<div class="oa-audio" bind:this={root}>
	<button
		type="button"
		class="oa-audio-btn btn btn--plate btn--sm"
		class:has-file={s.file !== null}
		id={ids.button}
		bind:this={button}
		aria-haspopup="dialog"
		aria-expanded={open}
		aria-controls={ids.dialog}
		aria-label={m.audio_button_aria({ name: s.file ? s.file.name : m.audio_none() })}
		title={s.file?.name}
		onclick={() => setOpen(!open)}
	>
		<span aria-hidden="true">♪</span>
		<span class="oa-audio-name">{s.file ? s.file.name : m.audio_button()}</span>
	</button>

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
			<button type="button" disabled={!s.file && !s.playing} onclick={togglePlay}>
				{s.playing ? m.audio_pause() : m.audio_play()}
			</button>
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
</div>

<style>
	.oa-audio {
		position: relative;
		--oa-accent: var(--accent, #ff7a2f);
		--oa-muted: var(--muted, #9a958c);
		--oa-text: var(--text, #f1ece2);
		--oa-rule: var(--rule, #34332f);
	}
	/* T1: the trigger is a bar button (Button recipe `.btn.btn--plate.btn--sm`, components.css),
	   bordered and sized like Neutro and Padrão Auri. */
	.oa-audio-btn {
		max-width: 190px;
	}
	.oa-audio-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 150px;
	}
	.oa-audio-btn.has-file {
		--btn-border: color-mix(in srgb, var(--oa-accent) 55%, transparent);
		--btn-fg: var(--accent-text, var(--oa-accent));
	}
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
	.oa-audio button:focus-visible,
	.oa-audio input[type='range']:focus-visible {
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
		.oa-audio-name {
			max-width: 70px;
		}
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
