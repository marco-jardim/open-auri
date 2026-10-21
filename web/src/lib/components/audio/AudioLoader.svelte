<!--
	Top-bar "♪ Áudio" trigger of the preview-audio popover (AudioPanel). FUX.2: the trigger is
	light and eager; the panel (and with it the engine module and the meters barrel) is its own
	chunk, imported on the trigger's first hover, focus or press, and opened once it arrived. The
	trigger keeps the bar's plate look (T1). The file never leaves the browser.
	FUX.NAV: a square bar button (♪, accent when a file is loaded) with the file name in its
	accessible name and tooltip; from 1600 px, room permitting, the name shows beside the glyph.
-->
<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import type { AudioEngine, AudioEngineState } from '#lib/audio/engine.ts';
	import { getAppContext, type AppContext } from '#lib/app/context.svelte.ts';
	import { LazyModule } from '#lib/app/lazy.svelte.ts';
	import { registerNativeBack } from '#lib/components/chrome/native-back.ts';
	// Direct file: the barrel would pull every primitive into the bar's first load.
	import Tooltip from '#lib/components/primitives/Tooltip.svelte';
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
	$effect(() => {
		if (!open) return;
		return registerNativeBack({
			canDismiss: () => true,
			dismiss: () => void setOpen(false, true)
		});
	});
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

	/**
	 * A press asked for the panel and its chunk is still on the way. A touch press warms the chunk
	 * only on pointerdown, a few ms before the click: the first tap must still open the panel once
	 * the chunk arrived (FUX.Q M1), and a press elsewhere (or Escape) meanwhile cancels the request.
	 */
	let wantOpen = false;
	let opening: Promise<void> | null = null;

	async function openWhenLoaded(): Promise<void> {
		wantOpen = true;
		try {
			await panel.load();
		} catch (error) {
			wantOpen = false;
			console.error('Audio panel could not load', error);
			return;
		}
		if (!wantOpen) return;
		wantOpen = false;
		await setOpen(true);
	}

	async function toggle(): Promise<void> {
		if (open) {
			await setOpen(false);
			return;
		}
		// Another press while the chunk loads joins the same opening (it never toggles it shut).
		wantOpen = true;
		opening ??= openWhenLoaded().finally(() => {
			opening = null;
		});
		await opening;
	}

	// The panel is positioned `fixed` from the button, so the bar (or the row it sits in) never
	// clips it at its height.
	const POP_WIDTH = 320;
	const label = $derived(m.audio_button_aria({ name: s?.file ? s.file.name : m.audio_none() }));
	let tipOpen = $state(false);
	// The open panel names itself; the trigger's tooltip would cover it.
	$effect(() => {
		if (open && tipOpen) tipOpen = false;
	});
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
		// The dispatch path, not `root.contains(target)`: a target the press re-rendered away
		// (detached before the event reached the window) is still inside when it was.
		if (!root || event.composedPath().includes(root)) return;
		wantOpen = false;
		if (open) open = false;
	}

	/**
	 * Escape closes the open panel and is consumed there (FUX.Q N5): `preventDefault` tells the
	 * page tour (which checks `defaultPrevented`) and the layout's shortcuts that the key was
	 * used. Listened on the document in the bubble phase so it runs before any window listener
	 * (the tour's included, whatever their registration order), and after a tooltip inside the
	 * panel, whose capture listener consumes the first Escape itself.
	 */
	function onEscape(event: KeyboardEvent): void {
		if (event.key !== 'Escape' || event.defaultPrevented) return;
		if (!open) {
			// Nothing shown yet: drop a pending open, leave the key to whoever owns it.
			wantOpen = false;
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		void setOpen(false, true);
	}
</script>

<!-- The window listener only sees keys dispatched at the window itself (never through the
     document); the document one has already consumed every other Escape. -->
<svelte:document onkeydown={onEscape} />
<svelte:window
	onclick={onWindowClick}
	onkeydown={onEscape}
	onresize={onWindowResize}
	onscroll={onWindowResize}
/>

<div class="oa-audio" bind:this={root}>
	<button
		type="button"
		class="oa-audio-btn btn btn--plate btn--sm btn--bar"
		class:has-file={(s?.file ?? null) !== null}
		id={ids.button}
		bind:this={button}
		aria-haspopup="dialog"
		aria-expanded={open}
		aria-controls={panel.current ? ids.dialog : undefined}
		aria-label={label}
		onpointerenter={warmPanel}
		onpointerdown={warmPanel}
		onfocus={warmPanel}
		onclick={toggle}
	>
		<span class="oa-audio-glyph" aria-hidden="true">♪</span>
		<span class="oa-audio-name">{s?.file ? s.file.name : m.audio_button()}</span>
	</button>
	<Tooltip text={label} anchor={open ? null : button} bind:open={tipOpen} />

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
	/* T1: the trigger is a bar button (recipe `.btn.btn--plate.btn--sm.btn--bar`, components.css):
	   square with the glyph by default; the name stays in the accessible name and the tooltip. */
	.oa-audio-btn {
		width: var(--btn-h);
		padding: 0;
	}
	.oa-audio-glyph {
		font-size: var(--fs-ui);
		line-height: 1;
	}
	.oa-audio-name {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.oa-audio-btn.has-file {
		--btn-border: color-mix(in srgb, var(--oa-accent) 55%, transparent);
		--btn-fg: var(--accent-text, var(--oa-accent));
	}
	.oa-audio-btn:focus-visible {
		outline: 2px solid var(--oa-accent);
		outline-offset: 3px;
	}
	/* Wide bar (FUX.NAV): the file name beside the glyph, unless the bar's guard squeezes it. */
	@media (min-width: 1600px) {
		.oa-audio-btn {
			width: auto;
			max-width: 190px;
			padding: 0 var(--btn-pad);
		}
		.oa-audio-name {
			position: static;
			width: auto;
			max-width: 150px;
			height: auto;
			clip-path: none;
			text-overflow: ellipsis;
		}
	}
	:global([data-squeeze~='1']) .oa-audio-btn {
		width: var(--btn-h);
		padding: 0;
	}
	:global([data-squeeze~='1']) .oa-audio-name {
		position: absolute;
		width: 1px;
		height: 1px;
		clip-path: inset(50%);
	}
	/* Panel styles live in AudioPanel.svelte (its own chunk). */
</style>
