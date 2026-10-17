<!--
	The listening room (spec §1.6 and §3, Teste cego row): stage, curtain, light cone and the
	three floor plates in perspective. Every movement follows real test state: the plates swap
	only during the real three-second swap, the curtain rises only on the result and the lamp
	lights only when the positions are settled. The dust in the cone is the one declared
	decoration: hero only, a finite drift, never rendered with reduced motion.
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import TesteCegoArt from '#lib/components/art/TesteCegoArt.svelte';
	import Button from '#lib/components/primitives/Button.svelte';
	import Lamp from '#lib/components/primitives/Lamp.svelte';
	import { Explainer, TourTrigger } from '#lib/components/comprehension/index.ts';

	let {
		revealed = false,
		moving = false,
		selected = -1,
		names = [],
		count = 3,
		disabled = true,
		reducedMotion = false,
		onselect
	}: {
		revealed?: boolean;
		moving?: boolean;
		selected?: number;
		names?: string[];
		count?: number;
		disabled?: boolean;
		/** Reduced motion: no dust, no swap choreography, instant curtain. */
		reducedMotion?: boolean;
		onselect: (index: number) => void;
	} = $props();
	const uid = $props.id();
	let helpOpen = $state(false);

	/** Plates in the scene's 1600 × 600 frame (mock geometry): box and trapezoid points. */
	const plates = [
		{ x: 480, w: 175.6, points: '51.6,0 175.6,0 160,66 0,66', swap: '14.5cqw' },
		{ x: 720, w: 160, points: '18,0 142,0 160,66 0,66', swap: '0cqw' },
		{ x: 944.4, w: 175.6, points: '0,0 124,0 175.6,66 15.6,66', swap: '-14.5cqw' }
	] as const;
	const speakers = [568, 800, 1032] as const;

	/** Deterministic dust (same markup on the server and the client). */
	const motes = (() => {
		let seed = 7;
		const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
		return Array.from({ length: 22 }, () => {
			const y = 90 + next() * 440;
			const half = 32 + ((y - 26) / 574) * 418;
			return {
				x: (800 + (next() * 2 - 1) * half * 0.8).toFixed(1),
				y: y.toFixed(1),
				r: (0.9 + next() * 1.4).toFixed(2),
				style: `--d:${(10 + next() * 8).toFixed(1)}s;--del:${(next() * 6).toFixed(1)}s;--dx:${((next() * 2 - 1) * 24).toFixed(1)}px;--dy:${(20 + next() * 40).toFixed(1)}px;--o:${(0.25 + next() * 0.45).toFixed(2)}`
			};
		});
	})();

	// The three plates always stay on the floor (a plate that disappeared while focused would
	// drop its reason tooltip mid-update); a test with two candidates marks the third unused.
	const plateReason = (position: number) =>
		reason ?? (position >= count ? m.cego_fux_reason_no_position() : null);
	const reason = $derived(
		moving ? m.cego_fux_reason_moving() : disabled ? m.cego_fux_reason_idle() : null
	);
	const settled = $derived(!disabled && !moving);
	const idle = $derived(disabled && !revealed && !moving);
</script>

<section
	class="room"
	class:revealed
	class:moving
	class:still={reducedMotion}
	aria-label={m.cego_title()}
	data-tour="cego-result"
>
	<div class="frame">
		<svg viewBox="0 0 1600 600" role="img" aria-label={m.cego_scene()}>
			<defs>
				<linearGradient id="{uid}-wall" x2="0" y2="1"
					><stop stop-color="#21190f" /><stop offset="1" stop-color="#080605" /></linearGradient
				>
				<pattern id="{uid}-slats" width="34" height="40" patternUnits="userSpaceOnUse"
					><rect width="26" height="40" fill="#201910" /><rect
						x="26"
						width="8"
						height="40"
						fill="#090706"
					/></pattern
				>
				<pattern id="{uid}-weave" width="5" height="5" patternUnits="userSpaceOnUse"
					><rect width="5" height="2" fill="#ded0ab" opacity=".035" /><rect
						width="2"
						height="5"
						fill="#000"
						opacity=".3"
					/></pattern
				>
				<linearGradient id="{uid}-pleat"
					><stop stop-color="#000" stop-opacity=".5" /><stop
						offset=".52"
						stop-color="#fff0d0"
						stop-opacity=".07"
					/><stop offset="1" stop-color="#000" stop-opacity=".5" /></linearGradient
				>
				<pattern id="{uid}-folds" width="96" height="428" patternUnits="userSpaceOnUse"
					><rect width="96" height="428" fill="url(#{uid}-pleat)" /></pattern
				>
				<linearGradient id="{uid}-light" x2="0" y2="1"
					><stop stop-color="#ffe2a6" stop-opacity=".2" /><stop
						offset="1"
						stop-color="#ffd27a"
						stop-opacity="0"
					/></linearGradient
				>
				<radialGradient id="{uid}-floor"
					><stop stop-color="#ffd27a" stop-opacity=".18" /><stop
						offset="1"
						stop-color="#ffd27a"
						stop-opacity="0"
					/></radialGradient
				>
			</defs>
			<rect width="1600" height="600" fill="#050404" />
			<rect y="40" width="1600" height="430" fill="url(#{uid}-wall)" />
			<rect y="40" width="1600" height="430" fill="url(#{uid}-slats)" opacity=".55" />
			<g stroke="#ffd27a" stroke-opacity=".17" fill="none">
				<path d="M568 362 L800 466 M800 362 V466 M1032 362 L800 466 M500 364 H1100" />
				<ellipse cx="800" cy="466" rx="78" ry="10" />
			</g>
			{#each speakers.slice(0, count) as x, index (x)}
				<g class="speaker" transform="translate({x} 362)">
					<rect
						x="-62"
						y="-262"
						width="124"
						height="262"
						rx="9"
						fill="#070707"
						stroke="#ffd27a"
						stroke-opacity=".45"
					/>
					<circle cy="-215" r="17" fill="#10100e" stroke="#343027" />
					<circle cy="-150" r="40" fill="#10100e" stroke="#343027" />
					<circle cy="-62" r="40" fill="#10100e" stroke="#343027" />
					{#if revealed}<text y="-280" text-anchor="middle" fill="#ffd27a" font-size="20"
							>{names[index] ?? ''}</text
						>{/if}
				</g>
			{/each}
			<g class="scrim">
				<rect y="40" width="1600" height="428" fill="#0b0a09" />
				<rect y="40" width="1600" height="428" fill="url(#{uid}-weave)" />
				<rect y="40" width="1600" height="428" fill="url(#{uid}-folds)" />
				<rect y="40" width="1600" height="428" fill="url(#{uid}-light)" opacity=".5" />
				<rect y="454" width="1600" height="14" fill="#050404" />
			</g>
			<rect y="30" width="1600" height="11" fill="#302921" />
			<path d="M754 0 H846 L838 22 H762 Z" fill="#28221b" />
			<ellipse cx="800" cy="24" rx="40" ry="9" fill="#ffe2a6" opacity=".7" />
			<rect y="468" width="1600" height="132" fill="#0c0907" />
			<ellipse cx="800" cy="550" rx="470" ry="70" fill="url(#{uid}-floor)" />
			<polygon points="768,26 832,26 1250,600 350,600" fill="url(#{uid}-light)" />
			{#if !reducedMotion}
				<g class="dust" aria-hidden="true">
					{#each motes as mote, index (index)}<circle
							class="mote"
							cx={mote.x}
							cy={mote.y}
							r={mote.r}
							style={mote.style}
						/>{/each}
				</g>
			{/if}
			<circle class="lock" cx="800" cy="478" r="4" fill={settled ? '#ffd27a' : '#57401f'} />
		</svg>
		<!-- FUX.ART.3: decorative art over the drawing, under the plates and every text. -->
		<TesteCegoArt place="scene" />
		<div class="plates">
			{#each plates as plate, position (position)}
				<Button
					variant="plate"
					class="cego-plate"
					style="--left:{(plate.x / 16).toFixed(3)}%;--width:{(plate.w / 16).toFixed(
						3
					)}%;--swap:{plate.swap}"
					aria-label={m.cego_position({ number: position + 1 })}
					aria-pressed={selected === position}
					disabledReason={plateReason(position)}
					onclick={() => onselect(position)}
				>
					<svg
						class="plate-shape"
						viewBox="0 0 {plate.w} 66"
						preserveAspectRatio="none"
						aria-hidden="true"><polygon points={plate.points} /></svg
					>
					<span class="plate-num" aria-hidden="true">{position + 1}</span>
				</Button>
			{/each}
		</div>
	</div>
	<div class="room-title">
		<div class="eyebrow">{m.cego_eyebrow()}</div>
		<h1>{m.cego_heading()}</h1>
		<p>{m.cego_lede()}</p>
		<div class="room-tools">
			<Explainer term="teste-cego" />
			<TourTrigger page="teste-cego" />
		</div>
	</div>
	<div class="cue" aria-hidden="true">
		<Lamp on={settled} class="cue-lamp" />
		<span class="cue-text"
			>{moving ? m.cego_shuffling() : revealed ? m.cego_revealed() : m.cego_closed()}</span
		>
		{#if idle}<span class="cue-sub">{m.cego_fux_waiting()}</span>{/if}
	</div>
	<div class="room-help">
		<Button
			variant="ghost"
			size="sm"
			aria-label={m.cego_fux_shortcuts_aria()}
			aria-expanded={helpOpen}
			aria-controls="{uid}-help"
			onclick={() => (helpOpen = !helpOpen)}
			><span aria-hidden="true">?</span> {m.cego_fux_shortcuts_button()}</Button
		>
		<p id="{uid}-help" class="help-panel" hidden={!helpOpen}>{m.cego_shortcuts()}</p>
	</div>
</section>

<style>
	.room {
		position: relative;
		height: clamp(400px, 64vh, 660px);
		background: #070605;
		overflow: hidden;
		isolation: isolate;
		container-type: size;
	}
	/* The scene keeps its 8:3 frame and is cropped like `slice`, so the HTML plates stay on the
	   drawn floor at every viewport. */
	.frame {
		position: absolute;
		left: 50%;
		top: 50%;
		width: max(100cqw, calc(100cqh * 8 / 3));
		aspect-ratio: 8 / 3;
		transform: translate(-50%, -50%);
		container-type: inline-size;
	}
	.frame > svg {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
	}
	.plates {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}
	.plates :global(.btn.cego-plate) {
		position: absolute;
		left: var(--left);
		width: var(--width);
		top: 83.333%;
		height: 11%;
		min-height: 0;
		padding: 0;
		border: 0;
		background: none;
		box-shadow: none;
		pointer-events: auto;
		color: var(--text-2);
	}
	.plates :global(.btn.cego-plate .btn__label) {
		position: absolute;
		inset: 0;
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
		stroke-dasharray: 10 6;
		vector-effect: non-scaling-stroke;
		transition:
			fill var(--dur-slow) var(--ease-out),
			stroke var(--dur-slow) var(--ease-out);
	}
	.plate-num {
		position: relative;
		font: 500 clamp(var(--fs-title), 2.25cqw, var(--fs-display-m)) / 1 var(--face-body);
		font-variant-numeric: tabular-nums;
	}
	.plates :global(.btn.cego-plate:hover .plate-shape polygon) {
		fill: rgb(236 231 221 / 0.07);
	}
	.plates :global(.btn.cego-plate[aria-pressed='true'] .plate-shape polygon) {
		fill: rgb(255 210 122 / 0.16);
		stroke: var(--accent);
		stroke-dasharray: none;
	}
	.plates :global(.btn.cego-plate[aria-pressed='true']) {
		color: var(--accent-text, var(--accent));
	}
	.plates :global(.btn.cego-plate[aria-disabled='true']) {
		opacity: 0.6;
	}
	/* Real swap only: `moving` is true exactly while the test swaps positions (3 s). */
	.moving .plates :global(.btn.cego-plate) {
		animation: plate-swap 3s var(--ease-in-out);
	}
	@keyframes plate-swap {
		0%,
		100% {
			translate: 0 0;
			opacity: 1;
		}
		35%,
		65% {
			translate: var(--swap) 0;
			opacity: 0.25;
		}
	}
	.mote {
		fill: #ffe7b5;
		opacity: 0;
		animation: drift var(--d, 14s) linear var(--del, 0s) 2;
	}
	@keyframes drift {
		0% {
			opacity: 0;
			transform: translate(0, 0);
		}
		15%,
		85% {
			opacity: var(--o, 0.5);
		}
		100% {
			opacity: 0;
			transform: translate(var(--dx, 10px), var(--dy, 30px));
		}
	}
	.room-title {
		position: absolute;
		left: clamp(16px, 4vw, 56px);
		top: clamp(18px, 5vh, 46px);
		max-width: 440px;
		pointer-events: none;
	}
	.eyebrow {
		font: 400 var(--fs-eyebrow) var(--face-data);
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: #d3b780;
	}
	h1 {
		font: italic 400 var(--fs-display-xl) / 0.95 var(--face-display);
		color: #f4ecdc;
		margin: 0.18em 0 0.22em;
		text-shadow: 0 2px 24px #000;
	}
	.room-title p {
		color: var(--text-2);
		max-width: 380px;
		font-size: var(--fs-body);
		text-shadow: 0 1px 8px #000;
	}
	.room-tools {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-top: var(--space-3);
		pointer-events: auto;
	}
	.cue {
		position: absolute;
		right: clamp(12px, 3vw, 40px);
		top: clamp(18px, 5vh, 46px);
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 4px 12px;
		align-items: center;
		min-width: 210px;
		padding: 12px 16px;
		border: 1px solid rgb(255 255 255 / 0.06);
		border-radius: var(--rad-lg);
		background: linear-gradient(#1b1916, #100f0d);
		box-shadow: var(--elev-2);
	}
	.cue :global(.cue-lamp) {
		grid-row: span 2;
	}
	.cue-text {
		font: 500 var(--fs-caption) var(--face-data);
		text-transform: uppercase;
		letter-spacing: 0.14em;
		color: var(--text);
	}
	.cue-sub {
		font: 400 var(--fs-caption) var(--face-data);
		color: var(--muted-hi);
	}
	.room-help {
		position: absolute;
		right: clamp(12px, 3vw, 40px);
		bottom: 14px;
		display: grid;
		justify-items: end;
		gap: var(--space-2);
	}
	.help-panel {
		order: -1;
		max-width: 300px;
		margin: 0;
		padding: var(--space-3);
		border: 1px solid var(--rule-control);
		border-radius: var(--rad-lg);
		background: var(--ink-3);
		color: var(--text-2);
		font-size: var(--fs-small);
	}
	.help-panel[hidden] {
		display: none;
	}
	.scrim {
		transition: transform 1.9s cubic-bezier(0.65, 0, 0.2, 1);
	}
	.revealed .scrim {
		transform: translateY(-430px);
	}
	.moving .speaker {
		animation: shuffle 3s ease-in-out;
	}
	@keyframes shuffle {
		50% {
			translate: 100px 0;
		}
	}
	@media (max-width: 760px) {
		.room {
			height: auto;
			aspect-ratio: 16/11;
			min-height: 250px;
		}
		h1 {
			font-size: var(--fs-display-m);
			max-width: 220px;
		}
		.room-title p {
			display: none;
		}
		.eyebrow {
			max-width: 200px;
		}
		.cue {
			top: auto;
			bottom: 28%;
			min-width: 0;
			padding: 6px 8px;
		}
		.cue-sub {
			display: none;
		}
		.room-help {
			bottom: 8px;
		}
	}
	.still .scrim {
		transition: none;
	}
	@media (prefers-reduced-motion: reduce) {
		.scrim,
		.plate-shape polygon {
			transition: none;
		}
		.moving .speaker,
		.moving .plates :global(.btn.cego-plate),
		.mote {
			animation: none;
		}
		.dust {
			display: none;
		}
	}
</style>
