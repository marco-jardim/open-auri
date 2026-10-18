<!--
	The listening-room stage (Teste cego; homage to Floyd Toole and Sean Olive). At Harman's lab
	the loudspeakers stood behind an acoustically transparent screen and a pneumatic shuffler
	moved them between positions, so listeners judged sound, not brand. Here: a woven curtain over
	three position bays, each with the same dim cabinet on a rail, a lamp above each position and
	a mechanical position counter. Every movement is real state, never a simulation:

	- a lamp lights when the test has settled on its position (the test's own state);
	- only while live meter frames arrive (the preview's pre-volume meter bus), the playing bay is
	  backlit and its woofer, the light behind the cloth and the ripple on the folds follow the
	  real level, frame by frame. With no frame the stage rests in DATA: dim and still;
	- the cabinets slide on their rails only while the test really swaps positions (`moving`, the
	  test's three seconds of silence); the animation follows that state and never drives it;
	- the curtain rises only on the result, and only then do names, curves and scores appear.
	  Before that the three bays are identical: nothing on stage tells one candidate from another.

	Reduced motion: no ripple, no rail move, no flip and an instant curtain; the level is a
	brightness step updated at most at 10 Hz. Each bay is a wrapper around two sibling controls:
	a real button (the same selection as the console keys and the 1, 2, 3 shortcuts) that says why
	when it is unavailable, and, during Escuta, the position's score fader on the floor (a native
	range: the test's own rating state, 0 to 10 in steps of 0.5, unlocked once the position was
	heard). The fader shows only the position number and the score; at the result it becomes a
	read-only display of the score given.
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import type { PreviewCurve } from '#lib/audio/engine.ts';
	import type { MeterSource, MeterUpdate } from '#lib/audio/meters.ts';
	import TesteCegoArt from '#lib/components/art/TesteCegoArt.svelte';
	import Button from '#lib/components/primitives/Button.svelte';
	import Lamp from '#lib/components/primitives/Lamp.svelte';
	import { ThrottledNumber } from '#lib/components/meters/motion.svelte.ts';
	import { levelOf, railMoves, sparkPath, stepLevel } from './stage.ts';

	let {
		revealed = false,
		moving = false,
		selected = -1,
		names = [],
		curves = [],
		scores = [],
		top = -1,
		tied = false,
		count = 3,
		disabled = true,
		reducedMotion = false,
		meter = null,
		scoring = false,
		ratings = [],
		rateable = [],
		onselect,
		onpick,
		onrate
	}: {
		/** The result is shown: the curtain is up and the bays carry names, curves and scores. */
		revealed?: boolean;
		/** The test is swapping positions right now (its own three-second silence). */
		moving?: boolean;
		/** Position the test plays, or -1. */
		selected?: number;
		/** Revealed only: each position's candidate name, curve and formatted mean score. */
		names?: readonly string[];
		curves?: readonly (PreviewCurve | null)[];
		scores?: readonly (string | null)[];
		/** Revealed only: the position with the highest mean, or -1 (none, or a tie). */
		top?: number;
		tied?: boolean;
		count?: number;
		disabled?: boolean;
		reducedMotion?: boolean;
		/** Live level of what plays (pre-volume); null when nothing of this test plays. */
		meter?: MeterSource | null;
		/** Escuta: each bay carries its own score fader on the floor. */
		scoring?: boolean;
		/** Each position's rating (0 to 10, null when not rated): live in Escuta, final at the result. */
		ratings?: readonly (number | null)[];
		/** Escuta: the positions heard so far, the only ones that can be rated. */
		rateable?: readonly boolean[];
		onselect: (index: number) => void;
		/** Inline call to action while nothing is loaded: open the candidates step. */
		onpick?: () => void;
		/** A fader moved: the position and the input's raw value (the test validates it). */
		onrate?: (index: number, value: string) => void;
	} = $props();
	const uid = $props.id();
	const positions = [0, 1, 2] as const;
	let helpOpen = $state(false);

	// Real frames only: a tap (or a test double) pushes updates; nothing is ever synthesised.
	let update = $state.raw<MeterUpdate>({ mode: 'data', frame: null });
	$effect(() => {
		const source = meter;
		update = { mode: 'data', frame: null };
		if (!source) return;
		return source.subscribe((value) => {
			update = value;
		});
	});

	const settled = $derived(!disabled && !moving);
	const idle = $derived(disabled && !revealed && !moving);
	/** The bay whose cabinet plays: settled on a real position, curtain closed. */
	const active = $derived(
		settled && !revealed && selected >= 0 && selected < count ? selected : -1
	);
	const raw = $derived(active >= 0 ? levelOf(update) : null);
	// Reduced motion: a static brightness step, at most ten updates a second. Only real levels
	// are pushed, so the first frame after silence shows at once.
	const steady = new ThrottledNumber();
	$effect(() => {
		if (reducedMotion && raw !== null) steady.push(stepLevel(raw));
	});
	$effect(() => () => steady.destroy());
	const level = $derived(raw === null ? null : reducedMotion ? steady.value : raw);
	const live = $derived(level !== null);
	const rails = $derived(railMoves(count));
	const sparks = $derived(revealed ? curves.map((curve) => (curve ? sparkPath(curve) : null)) : []);
	const shown = $derived(settled && selected >= 0 && selected < count ? String(selected + 1) : '−');
	const reason = $derived(
		moving ? m.cego_fux_reason_moving() : disabled ? m.cego_fux_reason_idle() : null
	);
	const bayReason = (position: number) =>
		reason ?? (position >= count ? m.cego_fux_reason_no_position() : null);
	const cueSub = $derived(
		idle ? m.cego_fux_waiting() : revealed && tied ? m.cego_tcwow_tie() : null
	);
	// Scores on the floor: live faders in Escuta, the scores given once the result is shown.
	const faders = $derived(scoring && !revealed);
	const scored = $derived(faders || (revealed && ratings.some((value) => value !== null)));
	const scoreFormat = $derived(
		new Intl.NumberFormat(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })
	);
	const formatScore = (value: number) => scoreFormat.format(value).replace(/-/g, '−');
	/** Why a fader is locked: the short visible word and the full reason for assistive tech. */
	const scoreLock = (position: number) =>
		moving
			? { short: m.cego_tcscore_wait(), long: m.cego_fux_reason_moving() }
			: rateable[position]
				? null
				: { short: m.cego_tcscore_listen(), long: m.cego_tcscore_listen_reason() };
	/**
	 * Taking the fader where it rests (a press without a move, or Enter or Space on it) rates that
	 * value too: an unrated position shows the middle of the scale without having that score.
	 */
	function keep(position: number, input: HTMLInputElement) {
		if (input.disabled || (ratings[position] ?? null) !== null) return;
		onrate?.(position, input.value);
	}
	function faderKey(event: KeyboardEvent & { currentTarget: HTMLInputElement }, position: number) {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		keep(position, event.currentTarget);
	}
</script>

<div
	class="stage"
	class:revealed
	class:moving
	class:live
	class:armed={!disabled}
	class:still={reducedMotion}
	style:--lvl={level ?? 0}
>
	<div class="stage-head">
		<div class="counter" aria-hidden="true">
			<span class="counter-label">{m.cego_tcwow_counter()}</span>
			<span class="counter-window"
				>{#key shown}<span class="digit">{shown}</span>{/key}</span
			>
		</div>
		<div class="cue" aria-hidden="true">
			<Lamp on={settled} class="cue-lamp" />
			<span class="cue-text"
				>{moving ? m.cego_shuffling() : revealed ? m.cego_revealed() : m.cego_closed()}</span
			>
			{#if cueSub}<span class="cue-sub">{cueSub}</span>{/if}
		</div>
		<span class="mode" data-mode={live ? 'live' : 'data'} aria-hidden="true"
			>{live ? m.meter_mode_live() : m.meter_mode_data()}</span
		>
		<div class="room-help">
			<Button
				variant="ghost"
				size="sm"
				aria-label={m.cego_fux_shortcuts_aria()}
				aria-expanded={helpOpen}
				aria-controls="{uid}-help"
				onclick={() => (helpOpen = !helpOpen)}
				><span aria-hidden="true">?</span>
				<span class="help-word">{m.cego_fux_shortcuts_button()}</span></Button
			>
			<p id="{uid}-help" class="help-panel" hidden={!helpOpen}>{m.cego_shortcuts()}</p>
		</div>
	</div>
	<div class="aperture" class:scored>
		<div class="backstage" role="img" aria-label={m.cego_scene()}>
			<div class="wall"></div>
			<div class="rails"></div>
			<div class="cabs">
				{#each positions as position (position)}
					{@const rail = rails[position]}
					<div
						class="cab"
						data-live={position === active && live}
						style="grid-column:{position + 1};--shift:{rail?.shift ?? 0};--far:{rail?.far ?? 0}"
					>
						{#if position < count}
							<span class="halo"></span>
							<svg class="box" viewBox="0 0 60 120" aria-hidden="true">
								<rect class="shell" x="1" y="1" width="58" height="118" rx="5" />
								<circle class="tw" cx="30" cy="19" r="7" />
								<g class="cone">
									<circle class="wf" cx="30" cy="57" r="19" />
									<circle class="cap" cx="30" cy="57" r="6" />
								</g>
								<circle class="wf low" cx="30" cy="98" r="12" />
							</svg>
						{/if}
					</div>
				{/each}
			</div>
		</div>
		<div class="scrim">
			{#if !reducedMotion && active >= 0 && live}
				<div class="ripples"><span class="ripple" style="grid-column:{active + 1}"></span></div>
			{/if}
			<span class="hem"></span>
		</div>
		<div class="floor"></div>
		<div class="valance"></div>
		<!-- Decorative art over the cloth, under the lamps, the bays and every text. -->
		<TesteCegoArt place="scene" />
		<div class="lamps" aria-hidden="true">
			{#each positions as position (position)}
				<span class="fixture" data-on={settled && selected === position}
					><span class="beam"></span><span class="fixture-head"></span><span class="lens"
					></span></span
				>
			{/each}
		</div>
		<div class="bays" class:scored role="group" aria-label={m.cego_tcwow_bays()}>
			{#each positions as position (position)}
				{@const bayLive = position === active && level !== null}
				{@const plaque = revealed && Boolean(names[position])}
				{@const rating = ratings[position] ?? null}
				{@const lock = scoreLock(position)}
				<div class="bay" style="grid-column:{position + 1}">
					<Button
						variant="ghost"
						class="cego-bay"
						aria-pressed={selected === position}
						disabledReason={bayReason(position)}
						data-position={position + 1}
						data-mode={bayLive ? 'live' : 'data'}
						data-level={bayLive && level !== null ? level.toFixed(2) : undefined}
						onclick={() => onselect(position)}
					>
						<span class="bay-spot" aria-hidden="true"></span>
						<!-- The name comes from the content, so the revealed plaque text is part of it. -->
						<span class="sr-only">{m.cego_position({ number: position + 1 })}</span>
						{#if plaque}
							<span class="plaque" class:top={top === position} id="{uid}-plaque-{position}">
								<span class="plaque-name">{names[position]}</span>
								{#if sparks[position]}<svg
										class="spark"
										viewBox="0 0 96 28"
										preserveAspectRatio="none"
										aria-hidden="true"
										><line x1="0" x2="96" y1="14" y2="14" /><path d={sparks[position]} /></svg
									>{/if}
								<span class="plaque-score"
									>{scores[position]
										? m.cego_tcwow_score({ value: scores[position] ?? '' })
										: m.cego_tcwow_no_score()}</span
								>
								{#if top === position}<span class="plaque-top">{m.cego_tcwow_top()}</span>{/if}
							</span>
						{/if}
						<span class="bay-plate" aria-hidden="true"
							><svg class="plate-shape" viewBox="0 0 100 30" preserveAspectRatio="none"
								><polygon points="14,1 86,1 99,29 1,29" /></svg
							><span class="plate-num">{position + 1}</span></span
						>
					</Button>
					<!-- The score is a sibling of the selection button, never inside it. -->
					{#if scored && position < count}
						{#if faders}
							<div class="score" data-rated={rating !== null}>
								<span class="score-num" aria-hidden="true">{position + 1}</span>
								<input
									class="fader"
									type="range"
									min="0"
									max="10"
									step="0.5"
									value={rating ?? 5}
									style:--pct="{(rating ?? 5) * 10}%"
									disabled={lock !== null}
									aria-label={m.cego_rating({ number: position + 1 })}
									aria-valuetext={rating === null ? m.cego_unrated() : formatScore(rating)}
									aria-describedby={lock ? `${uid}-lock-${position}` : undefined}
									oninput={(event) => onrate?.(position, event.currentTarget.value)}
									onpointerup={(event) => keep(position, event.currentTarget)}
									onkeydown={(event) => faderKey(event, position)}
								/>
								{#if lock}
									<span class="score-lock" id="{uid}-lock-{position}"
										><span aria-hidden="true">{lock.short}</span><span class="sr-only"
											>{lock.long}</span
										></span
									>
								{:else}
									<span class="score-value" aria-hidden="true"
										>{rating === null ? '−' : formatScore(rating)}</span
									>
								{/if}
							</div>
						{:else}
							<p class="score final" data-rated={rating !== null}>
								<span class="sr-only">{m.cego_rating({ number: position + 1 })}:</span>
								<span class="score-num" aria-hidden="true">{position + 1}</span>
								<span class="score-track" aria-hidden="true"
									><span class="score-fill" style:--pct="{(rating ?? 0) * 10}%"></span></span
								>
								<span class="score-value"
									>{rating === null ? m.cego_unrated() : formatScore(rating)}</span
								>
							</p>
						{/if}
					{/if}
				</div>
			{/each}
		</div>
		{#if idle && onpick}
			<div class="cta">
				<div class="cta-card">
					<p>{m.cego_tcwow_cta()}</p>
					<Button variant="primary" onclick={onpick}>{m.cego_pick()}</Button>
				</div>
			</div>
		{/if}
	</div>
</div>

<style>
	.stage {
		position: relative;
		isolation: isolate;
		min-width: 0;
		padding: 10px 10px 12px;
		border-radius: var(--rad-bezel, 20px);
		background: linear-gradient(170deg, #2e1f13, #1a110a 55%, #110b07);
		box-shadow:
			var(--elev-3),
			inset 0 1px rgb(255 255 255 / 0.06);
	}

	/* ---- Head: mechanical counter, the room cue, the meter mode and the shortcuts. ---- */
	.stage-head {
		position: relative;
		z-index: 2;
		display: flex;
		align-items: center;
		gap: clamp(8px, 1.2vw, 14px);
		min-width: 0;
		padding: 0 2px 8px;
	}
	.counter {
		display: flex;
		flex: none;
		align-items: center;
		gap: 6px;
	}
	.counter-label {
		font: 400 var(--fs-eyebrow) / 1 var(--face-data);
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--muted-hi);
	}
	.counter-window {
		position: relative;
		display: grid;
		place-items: center;
		width: 30px;
		height: 36px;
		overflow: hidden;
		border-radius: var(--rad-sm);
		background: linear-gradient(#0e0c0a 50%, #060504 50%);
		box-shadow: var(--well);
		perspective: 120px;
	}
	.counter-window::after {
		content: '';
		position: absolute;
		inset: 50% 0 auto;
		height: 1px;
		background: rgb(0 0 0 / 0.85);
	}
	.digit {
		font: 500 var(--fs-readout-l) / 1 var(--face-data);
		font-variant-numeric: tabular-nums slashed-zero;
		color: var(--accent);
		text-shadow: 0 0 8px rgb(255 210 122 / 0.5);
	}
	/* The counter flips only when the test settles on a new position (never on first paint). */
	.armed .digit {
		animation: counter-flip var(--dur-slow, 0.36s) var(--ease-mech, cubic-bezier(0.3, 1.4, 0.5, 1))
			both;
	}
	@keyframes counter-flip {
		from {
			opacity: 0.3;
			transform: rotateX(-88deg);
		}
	}
	.cue {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		flex: 1 1 auto;
		align-items: center;
		gap: 2px 10px;
		min-width: 0;
	}
	.cue :global(.cue-lamp) {
		grid-row: span 2;
	}
	.cue-text {
		font: 500 var(--fs-caption) / 1.3 var(--face-data);
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--text);
		overflow-wrap: anywhere;
	}
	.cue-sub {
		font: 400 var(--fs-caption) / 1.3 var(--face-data);
		color: var(--muted-hi);
	}
	.mode {
		flex: none;
		padding: 2px 6px;
		border: 1px solid currentColor;
		border-radius: var(--rad-xs, 4px);
		font: 600 var(--label-min) / 1.2 var(--face-body);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: #b5ad9f;
	}
	.mode[data-mode='live'] {
		color: var(--accent-text, var(--accent));
	}
	.room-help {
		position: relative;
		flex: none;
	}
	.help-panel {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		width: min(300px, 78vw);
		margin: 0;
		padding: var(--space-3);
		border: 1px solid var(--rule-control);
		border-radius: var(--rad-lg);
		background: var(--ink-3);
		box-shadow: var(--elev-2);
		color: var(--text-2);
		font-size: var(--fs-small);
	}
	.help-panel[hidden] {
		display: none;
	}

	/* ---- The proscenium opening; geometry in container units of its own box. ---- */
	.aperture {
		--valance: 13cqh;
		--floor-base: 19cqh;
		--floor: var(--floor-base);
		/* Floor depth the score faders add (one row; two rows on narrow bays). */
		--score-h: 44px;
		--side: 4cqw;
		--gap: 2.5cqw;
		position: relative;
		height: clamp(300px, 48vh, 480px);
		overflow: hidden;
		border-radius: var(--rad-lg);
		background: #060504;
		box-shadow:
			inset 0 0 0 1px rgb(0 0 0 / 0.8),
			0 1px 0 rgb(255 255 255 / 0.05);
		container-type: size;
	}
	/* Scores on the floor: the floor deepens by the faders' row, in front of the curtain. */
	.aperture.scored {
		--floor: calc(var(--floor-base) + var(--score-h));
	}
	.backstage,
	.wall {
		position: absolute;
		inset: 0;
	}
	.wall {
		bottom: var(--floor);
		background:
			radial-gradient(80% 70% at 50% 35%, rgb(255 200 130 / 0.06), transparent 70%),
			repeating-linear-gradient(90deg, #1b140d 0 2.2cqw, #0a0806 2.2cqw 2.9cqw);
		opacity: 0.7;
	}
	.rails {
		position: absolute;
		inset: auto 0 calc(var(--floor) + 1.5cqh);
		height: 3cqh;
		border-top: 1px solid rgb(255 210 122 / 0.12);
		border-bottom: 1px solid rgb(255 210 122 / 0.2);
	}
	.cabs,
	.lamps,
	.bays,
	.ripples {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		grid-template-rows: minmax(0, 1fr);
		column-gap: var(--gap);
	}
	.cabs {
		position: absolute;
		inset: var(--valance) var(--side) var(--floor);
		isolation: isolate;
	}
	/* The cabinet on the rear rail passes behind the others. */
	.cab {
		position: relative;
		z-index: calc(1 - var(--far, 0));
		display: flex;
		grid-row: 1;
		align-items: flex-end;
		justify-content: center;
		padding-bottom: 3cqh;
		transform-origin: 50% 100%;
	}
	.box {
		position: relative;
		width: auto;
		height: 46cqh;
		aspect-ratio: 1 / 2;
		overflow: visible;
	}
	/* A deeper floor leaves less room above it: the cabinet keeps clear of the valance. */
	.aperture.scored .box {
		height: min(46cqh, calc(63cqh - var(--score-h)));
	}
	.shell {
		fill: #0a0908;
		stroke: #ffd27a;
		stroke-opacity: 0.2;
		vector-effect: non-scaling-stroke;
	}
	.tw,
	.wf,
	.cap {
		fill: #121110;
		stroke: #35302a;
		vector-effect: non-scaling-stroke;
	}
	.cone {
		transform-box: fill-box;
		transform-origin: center;
	}
	/* The light behind the cloth: off unless real frames say this bay is playing. */
	.halo {
		position: absolute;
		left: 50%;
		bottom: -7cqh;
		width: 66cqh;
		height: 66cqh;
		margin-left: -33cqh;
		border-radius: 50%;
		background: radial-gradient(
			closest-side,
			rgb(255 222 160 / 0.85),
			rgb(255 186 100 / 0.3) 48%,
			transparent 74%
		);
		opacity: 0;
	}
	/* Meter ballistics come from the frames themselves: no transition on anything level-driven. */
	.cab[data-live='true'] .halo {
		opacity: calc(0.18 + var(--lvl, 0) * 0.82);
		transform: scale(calc(0.86 + var(--lvl, 0) * 0.24));
	}
	.cab[data-live='true'] .shell {
		stroke-opacity: calc(0.3 + var(--lvl, 0) * 0.6);
	}
	.cab[data-live='true'] .wf {
		stroke: var(--accent);
		stroke-opacity: calc(0.2 + var(--lvl, 0) * 0.7);
	}
	.cab[data-live='true'] .cone {
		transform: scale(calc(1 + var(--lvl, 0) * 0.08));
	}
	/* The shuffler: back to the rear rail, along it, forward again, only during the real swap. */
	.moving .cab {
		animation: cab-shuffle 3s var(--ease-in-out, cubic-bezier(0.65, 0, 0.35, 1)) both;
	}
	@keyframes cab-shuffle {
		0% {
			translate: 0 0;
			scale: 1;
		}
		14% {
			translate: 0 -3cqh;
			scale: 0.9;
		}
		24% {
			translate: 0 calc(-3cqh - var(--far, 0) * 3cqh);
			scale: calc(0.9 - var(--far, 0) * 0.08);
		}
		74% {
			translate: calc(var(--shift, 0) * (100% + var(--gap, 12px)))
				calc(-3cqh - var(--far, 0) * 3cqh);
			scale: calc(0.9 - var(--far, 0) * 0.08);
		}
		84% {
			translate: calc(var(--shift, 0) * (100% + var(--gap, 12px))) -3cqh;
			scale: 0.9;
		}
		/* Identical cabinets in a rotated order look the same as in the original order. */
		84.3% {
			translate: 0 -3cqh;
			scale: 0.9;
		}
		100% {
			translate: 0 0;
			scale: 1;
		}
	}

	/* ---- The acoustically transparent curtain. ---- */
	.scrim {
		position: absolute;
		inset: 0 0 var(--floor);
		background:
			repeating-linear-gradient(0deg, rgb(222 208 171 / 0.045) 0 1px, transparent 1px 3px),
			repeating-linear-gradient(90deg, rgb(0 0 0 / 0.3) 0 1px, transparent 1px 3px),
			repeating-linear-gradient(
				90deg,
				rgb(0 0 0 / 0.42) 0,
				rgb(255 236 200 / 0.05) 3.6cqw,
				rgb(0 0 0 / 0.42) 7.2cqw
			),
			linear-gradient(rgb(28 21 14 / 0.6), rgb(12 10 8 / 0.74));
		transition: translate 1.9s cubic-bezier(0.65, 0, 0.2, 1);
	}
	.scrim::after {
		content: '';
		position: absolute;
		inset: 0;
		background: radial-gradient(120% 60% at 50% 0, rgb(255 226 166 / 0.1), transparent 70%);
		pointer-events: none;
	}
	.revealed .scrim {
		translate: 0 -102%;
	}
	.hem {
		position: absolute;
		inset: auto 0 0;
		height: 2.4cqh;
		background: linear-gradient(#1d1610, #080605);
	}
	/* The light ripple on the folds follows the playing bay's real level, and nothing else. */
	.ripples {
		position: absolute;
		inset: var(--valance) var(--side) 0;
	}
	.ripple {
		position: relative;
		grid-row: 1;
		margin: 0 -30%;
		opacity: calc(var(--lvl, 0) * 0.6);
		mask-image: radial-gradient(50% 50% at 50% 60%, #000 30%, transparent);
	}
	.ripple::before,
	.ripple::after {
		content: '';
		position: absolute;
		inset: 0;
		background: repeating-linear-gradient(
			90deg,
			transparent 0 1.2cqw,
			rgb(255 218 150 / 0.5) 2cqw,
			transparent 2.8cqw 3.6cqw
		);
		transform: translateX(calc(var(--lvl, 0) * 1.4cqw)) scaleY(calc(1 + var(--lvl, 0) * 0.06));
	}
	.ripple::after {
		background: repeating-linear-gradient(
			90deg,
			transparent 0 2cqw,
			rgb(255 236 200 / 0.32) 3cqw,
			transparent 4cqw 5.4cqw
		);
		transform: translateX(calc(var(--lvl, 0) * -2cqw));
	}

	/* ---- Floor, valance, lamps. ---- */
	.floor {
		position: absolute;
		inset: auto 0 0;
		height: var(--floor);
		background:
			linear-gradient(rgb(255 210 122 / 0.06), transparent 35%),
			repeating-linear-gradient(0deg, transparent 0 1cqh, rgb(233 182 122 / 0.035) 1cqh 1.2cqh),
			linear-gradient(#1c140c, #0b0806);
		box-shadow: inset 0 1px rgb(255 210 122 / 0.14);
	}
	.valance {
		position: absolute;
		inset: 0 0 auto;
		height: var(--valance);
		background:
			linear-gradient(transparent 55%, rgb(0 0 0 / 0.55)),
			repeating-linear-gradient(90deg, #2a170e 0, #3d2416 1.6cqw, #2a170e 3.2cqw);
		box-shadow: 0 0.8cqh 1.6cqh rgb(0 0 0 / 0.7);
	}
	.lamps {
		position: absolute;
		inset: 0 var(--side) var(--floor);
		pointer-events: none;
	}
	.fixture {
		position: relative;
		grid-row: 1;
	}
	.fixture-head {
		position: absolute;
		top: calc(var(--valance) - 3cqh);
		left: 50%;
		width: 8cqh;
		height: 3cqh;
		translate: -50% 0;
		border-radius: 0 0 45% 45%;
		background: linear-gradient(#3b3229, #120e0b);
		box-shadow: inset 0 -1px rgb(255 255 255 / 0.08);
	}
	.lens {
		position: absolute;
		top: calc(var(--valance) - 0.6cqh);
		left: 50%;
		width: 4.4cqh;
		height: 1.2cqh;
		translate: -50% 0;
		border-radius: 50%;
		background: #2a241c;
		transition:
			background-color var(--dur-slow, 0.36s) var(--ease-out, ease-out),
			box-shadow var(--dur-slow, 0.36s) var(--ease-out, ease-out);
	}
	.beam {
		position: absolute;
		inset: var(--valance) -18% 0;
		clip-path: polygon(42% 0, 58% 0, 100% 100%, 0 100%);
		background: linear-gradient(rgb(255 226 166 / 0.2), rgb(255 210 122 / 0.05) 80%, transparent);
		opacity: 0;
		transition: opacity var(--dur-slow, 0.36s) var(--ease-out, ease-out);
	}
	.fixture[data-on='true'] .beam {
		opacity: 1;
	}
	.fixture[data-on='true'] .lens {
		background-color: #ffe2a6;
		box-shadow: 0 0 1.4cqh 0.3cqh rgb(255 210 122 / 0.6);
	}

	/* ---- Bays: a wrapper per position with the select button and, on the floor, the score. ---- */
	.bays {
		position: absolute;
		inset: var(--valance) var(--side) 0;
	}
	.bay {
		position: relative;
		grid-row: 1;
		min-width: 0;
		container: bay / inline-size;
	}
	.bays :global(.btn.cego-bay) {
		position: absolute;
		inset: 0;
		display: block;
		width: auto;
		height: auto;
		min-height: 0;
		padding: 0;
		border: 0;
		border-radius: var(--rad-md);
		background: none;
		box-shadow: none;
		transform: none;
		color: var(--text-2);
		white-space: normal;
	}
	/* With scores on the floor the button ends where the score row begins: no overlap. */
	.bays.scored :global(.btn.cego-bay) {
		bottom: var(--score-h);
	}
	.bays :global(.btn.cego-bay .btn__label) {
		position: absolute;
		inset: 0;
		display: block;
	}
	.bays :global(.btn.cego-bay:focus-visible) {
		outline: 2px solid var(--accent);
		outline-offset: -3px;
	}
	.bays :global(.btn.cego-bay[aria-disabled='true']) {
		color: var(--muted-hi);
	}
	.bays :global(.btn.cego-bay[aria-pressed='true']) {
		color: var(--accent-text, var(--accent));
	}
	.bay-spot {
		position: absolute;
		inset: 0 -12% var(--floor-base);
		background: radial-gradient(48% 42% at 50% 58%, rgb(255 226 166 / 0.16), transparent 72%);
		opacity: 0;
		transition: opacity var(--dur-base, 0.2s) var(--ease-out, ease-out);
	}
	.bays :global(.btn.cego-bay:not([aria-disabled='true']):hover .bay-spot),
	.bays :global(.btn.cego-bay:focus-visible .bay-spot) {
		opacity: 1;
	}
	.bay-plate {
		position: absolute;
		inset: auto 8% 3cqh;
		height: 13cqh;
		display: grid;
		place-items: center;
	}
	.plate-shape {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		overflow: visible;
	}
	.plate-shape polygon {
		fill: rgb(236 231 221 / 0.035);
		stroke: rgb(236 231 221 / 0.32);
		stroke-width: 1.5;
		stroke-dasharray: 8 5;
		vector-effect: non-scaling-stroke;
		transition:
			fill var(--dur-slow, 0.36s) var(--ease-out, ease-out),
			stroke var(--dur-slow, 0.36s) var(--ease-out, ease-out);
	}
	.bays :global(.btn.cego-bay:not([aria-disabled='true']):hover .plate-shape polygon) {
		fill: rgb(236 231 221 / 0.08);
	}
	.bays :global(.btn.cego-bay[aria-pressed='true'] .plate-shape polygon) {
		fill: rgb(255 210 122 / 0.16);
		stroke: var(--accent);
		stroke-dasharray: none;
	}
	.plate-num {
		position: relative;
		font: 500 clamp(15px, 8.5cqh, 30px) / 1 var(--face-body);
		font-variant-numeric: tabular-nums;
	}

	/* ---- Score row on the floor: a console fader per position, then the final score. ---- */
	.score {
		position: absolute;
		inset: auto 0 6px;
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: 2px 6px;
		margin: 0;
		padding: 2px 8px;
		border: 1px solid rgb(255 210 122 / 0.2);
		border-radius: var(--rad-md);
		background: linear-gradient(#17110b, #0a0705);
		box-shadow:
			var(--well),
			0 1px 0 rgb(255 255 255 / 0.04);
	}
	.score-num {
		color: var(--text-2);
		font: 600 var(--fs-caption) / 1 var(--face-body);
		font-variant-numeric: tabular-nums;
	}
	.score-value {
		min-width: 3ch;
		color: var(--muted-hi);
		font: 500 var(--fs-readout, 14px) / 1.1 var(--face-data);
		font-variant-numeric: tabular-nums slashed-zero;
		text-align: right;
		white-space: nowrap;
	}
	.score[data-rated='true'] .score-value {
		color: var(--accent-text, var(--accent));
		text-shadow: 0 0 6px rgb(255 210 122 / 0.45);
	}
	.score-lock {
		color: var(--muted-hi);
		font: 400 var(--label-min) / 1.2 var(--face-body);
		text-align: right;
		white-space: nowrap;
	}
	/* A native range keeps the name, the 0 to 10 range, the 0.5 step and the arrow, Home, End
	   and Page keys; only its look is the stage's: a slot with a fader cap. */
	.fader {
		--fill: #5a4a30;
		width: 100%;
		min-width: 0;
		height: 28px;
		margin: 0;
		padding: 0;
		border: 0;
		background: transparent;
		appearance: none;
		cursor: pointer;
	}
	.score[data-rated='true'] .fader {
		--fill: var(--accent);
	}
	.fader:disabled {
		cursor: not-allowed;
	}
	.fader:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
		border-radius: var(--rad-xs, 3px);
	}
	.fader::-webkit-slider-runnable-track {
		height: 4px;
		border-radius: 2px;
		background: linear-gradient(90deg, var(--fill) var(--pct, 50%), #2c251b var(--pct, 50%));
		box-shadow: inset 0 1px 1px rgb(0 0 0 / 0.8);
	}
	.fader::-moz-range-track {
		height: 4px;
		border-radius: 2px;
		background: #2c251b;
	}
	.fader::-moz-range-progress {
		height: 4px;
		border-radius: 2px;
		background: var(--fill);
	}
	.fader::-webkit-slider-thumb {
		width: 12px;
		height: 22px;
		margin-top: -9px;
		border: 1px solid rgb(0 0 0 / 0.75);
		border-radius: 3px;
		background: linear-gradient(#efe6d4, #9a8f80 48%, #3d3832 50%, #7d7468);
		box-shadow: 0 2px 3px rgb(0 0 0 / 0.7);
		appearance: none;
	}
	.fader::-moz-range-thumb {
		width: 12px;
		height: 22px;
		border: 1px solid rgb(0 0 0 / 0.75);
		border-radius: 3px;
		background: linear-gradient(#efe6d4, #9a8f80 48%, #3d3832 50%, #7d7468);
		box-shadow: 0 2px 3px rgb(0 0 0 / 0.7);
	}
	.fader:disabled::-webkit-slider-thumb {
		background: #3a342c;
		box-shadow: none;
	}
	.fader:disabled::-moz-range-thumb {
		background: #3a342c;
		box-shadow: none;
	}
	/* The result: the score given, read-only. */
	.score.final {
		min-height: 28px;
	}
	.score-track {
		position: relative;
		height: 4px;
		overflow: hidden;
		border-radius: 2px;
		background: #2c251b;
	}
	.score-fill {
		position: absolute;
		inset: 0 auto 0 0;
		width: var(--pct, 0%);
		background: var(--accent);
	}
	/* Narrow bays: number and value on top, the fader across the whole bay below. */
	@container bay (max-width: 140px) {
		.score {
			grid-template-columns: auto minmax(0, 1fr);
			padding: 2px 6px;
		}
		.score-num {
			grid-area: 1 / 1;
		}
		.score-value {
			grid-area: 1 / 2;
			justify-self: end;
		}
		/* Locked: the reason takes the whole top line (the number is on the plate above). */
		.score:has(.score-lock) .score-num {
			display: none;
		}
		.score-lock {
			grid-area: 1 / 1 / 2 / 3;
			justify-self: center;
			text-align: center;
			white-space: normal;
		}
		.fader,
		.score-track {
			grid-area: 2 / 1 / 3 / 3;
		}
		.score-track {
			margin-block: 6px 4px;
		}
	}

	/* ---- The reveal: names, curves and scores, only once the curtain is up. ---- */
	.revealed .wall {
		opacity: 1;
	}
	.revealed .halo {
		opacity: 0.16;
	}
	.revealed .shell {
		stroke-opacity: 0.5;
	}
	.plaque {
		position: absolute;
		inset: 3cqh 4% auto;
		display: grid;
		gap: 2px;
		padding: 6px 8px;
		border: 1px solid rgb(255 210 122 / 0.28);
		border-radius: var(--rad-md);
		background: rgb(10 8 6 / 0.94);
		box-shadow: var(--elev-2);
		text-align: left;
		animation: plaque-in 0.6s var(--ease-out, cubic-bezier(0.2, 0.8, 0.2, 1)) 1.4s both;
	}
	.plaque.top {
		border-color: var(--accent);
	}
	@keyframes plaque-in {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
	}
	.plaque-name {
		display: -webkit-box;
		overflow: hidden;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		color: var(--text);
		font: 600 var(--fs-small) / 1.25 var(--face-body);
		overflow-wrap: anywhere;
	}
	.spark {
		width: 100%;
		height: clamp(14px, 6cqh, 26px);
		overflow: visible;
	}
	.spark line {
		stroke: rgb(236 231 221 / 0.18);
		vector-effect: non-scaling-stroke;
	}
	.spark path {
		fill: none;
		stroke: var(--accent);
		stroke-width: 1.5;
		stroke-linejoin: round;
		vector-effect: non-scaling-stroke;
	}
	.plaque-score {
		color: var(--accent-text, var(--accent));
		font: 400 var(--fs-caption) / 1.3 var(--face-data);
		font-variant-numeric: tabular-nums;
	}
	.plaque-top {
		justify-self: start;
		padding: 1px 6px;
		border-radius: var(--rad-pill);
		background: var(--accent);
		color: var(--accent-ink, #1d1606);
		font: 600 var(--label-min) / 1.35 var(--face-body);
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	/* ---- Nothing loaded yet: say so where the eye is, and lead to the candidates. ---- */
	.cta {
		position: absolute;
		inset: var(--valance) var(--side) var(--floor);
		display: grid;
		place-items: center;
		pointer-events: none;
	}
	.cta-card {
		display: grid;
		justify-items: center;
		gap: 8px;
		max-width: min(340px, 100%);
		padding: 10px 14px;
		border: 1px solid rgb(255 210 122 / 0.3);
		border-radius: var(--rad-lg);
		background: rgb(10 8 6 / 0.92);
		box-shadow: var(--elev-2);
		text-align: center;
		pointer-events: auto;
	}
	.cta-card p {
		margin: 0;
		color: var(--text-2);
		font-size: var(--fs-small);
	}

	/* ---- Breakpoints: a band under the title, then a compact stage on phones. ---- */
	@media (max-width: 1099px) {
		.aperture {
			height: clamp(190px, 40vh, 400px);
		}
	}
	@media (max-width: 760px) {
		.stage {
			padding: 6px 6px 8px;
			border-radius: var(--rad-2xl, 16px);
		}
		.stage-head {
			gap: 8px;
			padding-bottom: 6px;
		}
		.counter-window {
			width: 26px;
			height: 30px;
		}
		.digit {
			font-size: var(--fs-title);
		}
		.aperture {
			height: clamp(132px, 29vh, 250px);
		}
		/* Escuta and the result: the stage grows a little for the score row, under half the screen. */
		.aperture.scored {
			height: clamp(196px, 36vh, 300px);
		}
	}
	@media (max-width: 600px) {
		.aperture {
			--score-h: 60px;
		}
	}
	@media (max-width: 480px) {
		.counter-label,
		.cue-sub,
		.help-word,
		.cta-card p {
			display: none;
		}
		.plaque {
			padding: 4px 5px;
		}
		.plaque-name {
			font-size: var(--fs-caption);
		}
	}

	/* ---- Reduced motion: no ripple, no rail move, no flip; instant curtain and crossfades. ---- */
	.still .scrim,
	.still .beam,
	.still .lens,
	.still .bay-spot,
	.still .plate-shape polygon {
		transition: none;
	}
	.still .cab,
	.still .digit,
	.still .plaque {
		animation: none;
	}
	.still .cone,
	.still .halo,
	.still .cab[data-live='true'] .cone,
	.still .cab[data-live='true'] .halo {
		transform: none;
	}
	@media (prefers-reduced-motion: reduce) {
		.scrim,
		.beam,
		.lens,
		.bay-spot,
		.plate-shape polygon {
			transition: none;
		}
		.cab,
		.moving .cab,
		.digit,
		.armed .digit,
		.plaque {
			animation: none;
		}
		.cab[data-live='true'] .cone,
		.cab[data-live='true'] .halo {
			transform: none;
		}
		.ripples {
			display: none;
		}
	}
</style>
