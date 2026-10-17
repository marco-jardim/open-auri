<!--
	Top-bar "♪ Áudio" trigger of the preview-audio popover (AudioPanel). FUX.2: the trigger is
	light and eager; the panel (and with it the engine module and the meters barrel) is its own
	chunk, imported on the trigger's first hover, focus or press, and opened once it arrived. The
	trigger keeps the bar's plate look (T1). The file never leaves the browser.
-->
<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import type { AudioEngine, AudioEngineState } from '#lib/audio/engine.ts';
	import { getAppContext, type AppContext } from '#lib/app/context.svelte.ts';
	import { LazyModule } from '#lib/app/lazy.svelte.ts';
	import type { VuReferenceStore } from '#lib/components/meters/index.ts';

	interface Props {
		/** Engine to drive; defaults to the page-wide singleton (created on mount, never during SSR). */
		engine?: AudioEngine;
		/** 0 VU reference store (`app.state.meterRef`); defaults to the app context's, when present. */
		meterRef?: VuReferenceStore | null;
	}

	let { engine: provided, meterRef }: Props = $props();
	const panel = new LazyModule(() => import('./AudioPanel.svelte'));

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

	let engine = $state.raw<AudioEngine | null>(null);
	let s = $state.raw<AudioEngineState | null>(null);
	let open = $state(false);
	let root: HTMLDivElement | undefined = $state();
	let button: HTMLButtonElement | undefined = $state();
	let dialog: HTMLDivElement | undefined = $state();

	onMount(() => {
		let unsubscribe: (() => void) | undefined;
		let disposed = false;
		const attach = (current: AudioEngine) => {
			if (disposed) return;
			engine = current;
			s = current.state();
			unsubscribe = current.onChange((next) => {
				s = next;
			});
		};
		if (provided) {
			attach(provided);
		} else {
			// Isolated use (no engine handed in): the shared engine module loads on demand.
			import('#lib/audio/engine.ts').then(
				(module) => attach(module.getAudioEngine()),
				(error: unknown) => console.error('Audio engine could not load', error)
			);
		}
		return () => {
			disposed = true;
			unsubscribe?.();
		};
	});

	/** Hover, focus or press: warm the panel chunk so the click opens it at once. */
	function warmPanel(): void {
		panel.request();
	}

	async function toggle(): Promise<void> {
		if (open) {
			await setOpen(false);
			return;
		}
		try {
			await panel.load();
		} catch (error) {
			console.error('Audio panel could not load', error);
			return;
		}
		await setOpen(true);
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
		class:has-file={(s?.file ?? null) !== null}
		id={ids.button}
		bind:this={button}
		aria-haspopup="dialog"
		aria-expanded={open}
		aria-controls={panel.current ? ids.dialog : undefined}
		aria-label={m.audio_button_aria({ name: s?.file ? s.file.name : m.audio_none() })}
		title={s?.file?.name}
		onpointerenter={warmPanel}
		onpointerdown={warmPanel}
		onfocus={warmPanel}
		onclick={toggle}
	>
		<span aria-hidden="true">♪</span>
		<span class="oa-audio-name">{s?.file ? s.file.name : m.audio_button()}</span>
	</button>

	{#if panel.current && engine && s}
		{@const Panel = panel.current}
		<Panel {engine} state={s} {open} {ids} {pos} {referenceStore} bind:dialog />
	{/if}
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
	.oa-audio-btn:focus-visible {
		outline: 2px solid var(--oa-accent);
		outline-offset: 3px;
	}
	/* Panel styles live in AudioPanel.svelte (its own chunk). */
	@media (max-width: 720px) {
		.oa-audio-name {
			max-width: 70px;
		}
	}
</style>
