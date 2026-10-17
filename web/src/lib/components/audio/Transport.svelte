<!--
	Transport (SEEK.1): play/pause, "Voltar ao início" and a seek bar for the shared preview
	engine, sized for page preview rows (`compact`, one row) or panels (`full`, the audio modal).

	- Seek bar: WAI-ARIA slider (focusable even when unavailable, the reason in a tooltip and in
	  aria-describedby). Keyboard: arrows ±5 s, PageUp/PageDown ±10 %, Home/End. Pointer: the
	  time previews while dragging and the seek is committed on release (cancel discards it).
	- Pink noise has no position: the bar is unavailable and reads "ruído rosa · contínuo".
	- Play: pauses while playing; continues a paused session (only the one tagged `session`, when
	  given); otherwise calls `onplay`, where the page keeps its own start logic (A/B creation and
	  `engine.start(mode, { startAt: 'random', session })`). Without `onplay` and nothing paused,
	  play says why it cannot act. It never starts audio by itself.
	- State: the host's `state` when it already subscribes (the audio panel), else its own
	  subscription. Position updates arrive from the engine at 5 Hz while playing; no animation,
	  so reduced motion changes nothing.
-->
<script module lang="ts">
	export type TransportVariant = 'compact' | 'full';
</script>

<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import type { AudioEngine, AudioEngineState } from '#lib/audio/engine.ts';
	import { clampSeek, formatClock, seekKeyTarget } from '#lib/audio/transport.ts';
	import { warmAudioOnPress } from '#lib/audio/warm.ts';
	// Direct files: the primitives barrel would pull every primitive into preview rows.
	import Button from '#lib/components/primitives/Button.svelte';
	import IconButton from '#lib/components/primitives/IconButton.svelte';
	import Tooltip from '#lib/components/primitives/Tooltip.svelte';

	interface Props {
		/** The preview engine (`app.audio`); null while it loads (every control then says why). */
		engine: AudioEngine | null | undefined;
		/** Engine state from the host's own subscription; omitted, Transport subscribes itself. */
		state?: AudioEngineState | null;
		variant?: TransportVariant;
		/**
		 * Starts this page's preview from the click (build the A/B, then `engine.start`). Called
		 * when nothing of this transport is paused; errors go to `onerror`.
		 */
		onplay?: () => void | Promise<void>;
		/** Continue only the paused session with this tag; another page's paused session gets `onplay`. */
		session?: string;
		/** Why play cannot start a new preview now (pause and resume stay available). */
		playDisabledReason?: string | null;
		/** Name of the play button when it starts a new preview (default "Tocar"). */
		startLabel?: string;
		/** Accessible name of the seek bar. */
		label?: string;
		/** Starting or resuming failed (engine codes also land in `state().error`). */
		onerror?: (error: unknown) => void;
	}

	let {
		engine = null,
		state: provided = null,
		variant = 'compact',
		onplay,
		session,
		playDisabledReason = null,
		startLabel,
		label,
		onerror
	}: Props = $props();

	const uid = $props.id();
	const seekReasonId = `${uid}-seek-reason`;

	// Own subscription, tagged with its engine so a swapped engine never shows a stale state.
	let latest = $state.raw<{ from: AudioEngine; state: AudioEngineState } | null>(null);
	$effect(() => {
		const current = engine;
		if (provided || !current) return;
		return current.onChange((next) => {
			latest = { from: current, state: next };
		});
	});
	const s = $derived.by((): AudioEngineState | null => {
		if (provided) return provided;
		if (!engine) return null;
		return latest?.from === engine ? latest.state : engine.state();
	});

	let slider: HTMLDivElement | undefined = $state();
	/** Time under the pointer while scrubbing (committed on release). */
	let scrub = $state<number | null>(null);
	let pointerId: number | null = null;
	let busy = $state(false);

	const total = $derived(s?.duration ?? null);
	const noise = $derived(s?.source === 'noise');
	const shown = $derived(scrub ?? s?.position ?? 0);
	const fraction = $derived(total ? Math.min(Math.max(shown / total, 0), 1) : 0);
	const elapsedText = $derived(formatClock(shown));
	const totalText = $derived(total === null ? '…' : formatClock(total));
	const valueText = $derived(
		noise ? m.transport_noise() : m.transport_valuetext({ elapsed: elapsedText, total: totalText })
	);
	const seekReason = $derived.by((): string | null => {
		if (!engine || !s) return m.transport_reason_no_engine();
		if (noise) return m.transport_reason_noise();
		if (total === null) return m.transport_reason_loading();
		return null;
	});

	type PlayAction = 'pause' | 'resume' | 'start';
	const action = $derived.by((): PlayAction | null => {
		if (!engine || !s) return null;
		if (s.playing) return 'pause';
		if (s.paused && (session === undefined || s.session === session)) return 'resume';
		return onplay ? 'start' : null;
	});
	const playReason = $derived.by((): string | null => {
		if (!engine || !s) return m.transport_reason_no_engine();
		if (action === 'start') return playDisabledReason?.trim() ? playDisabledReason.trim() : null;
		if (action === null) {
			return s.toggleReason === 'unsupported'
				? m.transport_toggle_unsupported()
				: m.transport_toggle_no_session();
		}
		return null;
	});
	const playLabel = $derived(
		action === 'pause'
			? m.transport_pause()
			: action === 'resume'
				? m.transport_resume()
				: (startLabel ?? m.transport_play())
	);

	async function play(): Promise<void> {
		const current = engine;
		const next = action;
		if (!current || !next || busy) return;
		if (next === 'pause') {
			current.pause();
			return;
		}
		busy = true;
		try {
			if (next === 'resume') await current.resume();
			else await onplay?.();
		} catch (error) {
			console.info('Transport: playback did not start', error);
			onerror?.(error);
		} finally {
			busy = false;
		}
	}

	function restart(): void {
		if (!seekReason) engine?.restart();
	}

	function valueAt(clientX: number, length: number): number {
		const rect = slider?.getBoundingClientRect();
		const ratio = rect && rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
		return clampSeek(Math.min(Math.max(ratio, 0), 1) * length, length);
	}

	function onKeydown(event: KeyboardEvent): void {
		if (!engine || seekReason || total === null) return;
		const target = seekKeyTarget(event.key, s?.position ?? 0, total);
		if (target === null) return;
		event.preventDefault();
		pointerId = null;
		scrub = null;
		engine.seek(target);
	}

	function onPointerDown(event: PointerEvent & { currentTarget: HTMLDivElement }): void {
		if (seekReason || total === null || event.button !== 0) return;
		const node = event.currentTarget;
		node.focus();
		pointerId = event.pointerId;
		try {
			node.setPointerCapture(event.pointerId);
		} catch (captureError) {
			// Synthetic or already released pointers cannot be captured; scrubbing still works.
			console.debug('Transport: pointer capture unavailable', captureError);
		}
		scrub = valueAt(event.clientX, total);
	}

	function onPointerMove(event: PointerEvent): void {
		if (pointerId !== event.pointerId || total === null) return;
		scrub = valueAt(event.clientX, total);
	}

	function onPointerUp(event: PointerEvent): void {
		if (pointerId !== event.pointerId) return;
		const target = total === null ? null : valueAt(event.clientX, total);
		pointerId = null;
		scrub = null;
		if (target !== null) engine?.seek(target);
	}

	function onPointerCancel(event: PointerEvent): void {
		if (pointerId !== event.pointerId) return;
		pointerId = null;
		scrub = null;
	}
</script>

<div
	class={['tp', `tp--${variant}`, noise && 'tp--noise']}
	role="group"
	aria-label={m.transport_group()}
>
	<div class="tp-buttons">
		<Button
			size="sm"
			class="tp-play"
			loading={busy}
			disabledReason={playReason}
			onclick={play}
			{@attach warmAudioOnPress(() => engine)}
		>
			<span class="tp-glyph" aria-hidden="true">
				{#if action === 'pause'}
					<svg viewBox="0 0 12 12" width="12" height="12" focusable="false">
						<path d="M2.5 1.5h2.5v9H2.5zM7 1.5h2.5v9H7z" fill="currentColor" />
					</svg>
				{:else}
					<svg viewBox="0 0 12 12" width="12" height="12" focusable="false">
						<path d="M3 1.5v9l7.5-4.5z" fill="currentColor" />
					</svg>
				{/if}
			</span>
			<span>{playLabel}</span>
		</Button>
		<IconButton
			size="sm"
			label={m.transport_restart()}
			disabledReason={seekReason}
			onclick={restart}
		>
			<svg viewBox="0 0 12 12" width="12" height="12" focusable="false">
				<path d="M2 1.5h1.6v9H2zM10.5 1.5v9L4.2 6z" fill="currentColor" />
			</svg>
		</IconButton>
	</div>

	{#if noise}
		<span class="tp-noise" aria-hidden="true">{m.transport_noise()}</span>
	{:else}
		<span class="tp-time tp-elapsed" aria-hidden="true">{elapsedText}</span>
	{/if}

	<div
		class="tp-seek"
		role="slider"
		tabindex="0"
		aria-label={label ?? m.transport_seek()}
		aria-valuemin={0}
		aria-valuemax={Math.floor(total ?? 0)}
		aria-valuenow={Math.floor(shown)}
		aria-valuetext={valueText}
		aria-disabled={seekReason ? 'true' : undefined}
		aria-describedby={seekReason ? seekReasonId : undefined}
		data-scrubbing={scrub !== null ? 'true' : undefined}
		bind:this={slider}
		onkeydown={onKeydown}
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={onPointerUp}
		onpointercancel={onPointerCancel}
		onlostpointercapture={onPointerCancel}
	>
		<span class="tp-track" aria-hidden="true">
			<span class="tp-fill" style:width={`${fraction * 100}%`}></span>
			{#if !seekReason}
				<span class="tp-thumb" style:left={`${fraction * 100}%`}></span>
			{/if}
		</span>
	</div>
	{#if seekReason}
		<Tooltip id={seekReasonId} text={seekReason} anchor={slider} />
	{/if}

	{#if !noise}
		<span class="tp-time tp-total" aria-hidden="true">{totalText}</span>
	{/if}
	{#if variant === 'full'}
		<span class="tp-loop">{m.transport_loop()}</span>
	{/if}
</div>

<style>
	.tp {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
		font-family: var(--face-body);
		color: var(--text);
	}
	.tp-buttons {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		flex: none;
	}
	/* Room for "Continuar" so the row does not jump when the label changes. */
	.tp :global(.tp-play) {
		min-width: 11ch;
	}
	.tp-glyph {
		display: inline-flex;
		margin-inline-end: var(--space-1);
	}
	.tp-glyph svg,
	.tp-buttons svg {
		display: block;
	}
	.tp-time {
		flex: none;
		min-width: 4ch;
		font-family: var(--face-data);
		font-weight: 400;
		font-size: var(--fs-caption);
		line-height: var(--lh-readout);
		font-variant-numeric: tabular-nums slashed-zero;
		letter-spacing: var(--tracking-data);
		color: var(--text-2);
	}
	.tp-elapsed {
		text-align: end;
	}
	.tp-noise,
	.tp-loop {
		flex: none;
		font-family: var(--face-data);
		font-weight: 400;
		font-size: var(--label-min);
		letter-spacing: var(--tracking-data);
		color: var(--muted);
		white-space: nowrap;
	}
	.tp-seek {
		position: relative;
		flex: 1 1 auto;
		min-width: 72px;
		height: 28px;
		display: flex;
		align-items: center;
		cursor: pointer;
		touch-action: none;
		user-select: none;
		border-radius: var(--rad-sm);
	}
	.tp-seek:focus-visible {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: var(--focus-offset);
	}
	.tp-seek[aria-disabled='true'] {
		cursor: not-allowed;
	}
	.tp-track {
		position: relative;
		width: 100%;
		height: 6px;
		border: 1px solid var(--rule-control);
		border-radius: var(--rad-pill);
		background: var(--ink);
		box-shadow: var(--well);
	}
	.tp-seek[aria-disabled='true'] .tp-track {
		border-style: dashed;
		background: transparent;
		box-shadow: none;
	}
	.tp-fill {
		position: absolute;
		inset: 0 auto 0 0;
		border-radius: inherit;
		background: var(--accent);
	}
	.tp-thumb {
		position: absolute;
		top: 50%;
		width: 12px;
		height: 12px;
		margin-left: -6px;
		transform: translateY(-50%);
		border-radius: 50%;
		background: var(--accent);
		box-shadow:
			0 0 0 2px var(--ink-2),
			var(--elev-1);
	}
	.tp-seek[data-scrubbing='true'] .tp-thumb {
		box-shadow:
			0 0 0 2px var(--ink-2),
			var(--glow-1, var(--elev-1));
	}

	/* Full (panels, the audio modal): bar on top, times under it, controls below. */
	.tp--full {
		display: grid;
		grid-template-columns: auto 1fr auto;
		grid-template-areas:
			'seek seek seek'
			'elapsed loop total'
			'buttons buttons buttons';
		gap: var(--space-1) var(--space-2);
		align-items: center;
	}
	.tp--full .tp-seek {
		grid-area: seek;
	}
	.tp--full .tp-elapsed,
	.tp--full .tp-noise {
		grid-area: elapsed;
		text-align: start;
	}
	.tp--full .tp-total {
		grid-area: total;
		text-align: end;
	}
	.tp--full .tp-loop {
		grid-area: loop;
		justify-self: center;
	}
	.tp--full .tp-buttons {
		grid-area: buttons;
		margin-top: var(--space-1);
	}
</style>
