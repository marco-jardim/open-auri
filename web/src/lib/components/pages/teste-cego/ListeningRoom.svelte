<!--
	The listening room (spec §1.6 and §3, Teste cego row): the page title and, beside it, the stage
	(Stage.svelte), a curtain over three identical loudspeakers that follows only real test state
	and real meter frames. The title keeps its own column on wide screens and sits above the stage
	everywhere else: the stage never pushes it aside nor paints under it.
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import type { PreviewCurve } from '#lib/audio/engine.ts';
	import type { MeterSource } from '#lib/audio/meters.ts';
	import { Explainer, TourTrigger } from '#lib/components/comprehension/index.ts';
	import Stage from './Stage.svelte';

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
		onselect,
		onpick
	}: {
		revealed?: boolean;
		moving?: boolean;
		selected?: number;
		names?: readonly string[];
		curves?: readonly (PreviewCurve | null)[];
		scores?: readonly (string | null)[];
		top?: number;
		tied?: boolean;
		count?: number;
		disabled?: boolean;
		/** Reduced motion: no ripple, no rail move, instant curtain, stepped level. */
		reducedMotion?: boolean;
		meter?: MeterSource | null;
		onselect: (index: number) => void;
		onpick?: () => void;
	} = $props();
</script>

<section
	class="room"
	class:revealed
	class:moving
	class:still={reducedMotion}
	aria-label={m.cego_title()}
	data-tour="cego-result"
>
	<div class="room-title">
		<div class="eyebrow">{m.cego_eyebrow()}</div>
		<h1>{m.cego_heading()}</h1>
		<p>{m.cego_lede()}</p>
		<div class="room-tools">
			<Explainer term="teste-cego" />
			<TourTrigger page="teste-cego" />
		</div>
	</div>
	<Stage
		{revealed}
		{moving}
		{selected}
		{names}
		{curves}
		{scores}
		{top}
		{tied}
		{count}
		{disabled}
		{reducedMotion}
		{meter}
		{onselect}
		{onpick}
	/>
</section>

<style>
	.room {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		align-items: center;
		gap: clamp(14px, 2.6vw, 40px);
		min-height: clamp(400px, 64vh, 660px);
		padding: clamp(20px, 5vh, 48px) clamp(12px, 4vw, 56px);
		overflow: hidden;
		isolation: isolate;
		background:
			radial-gradient(60% 80% at 76% 50%, rgb(255 190 110 / 0.07), transparent 70%),
			linear-gradient(#0d0a07, #050404);
	}
	.room-title {
		min-width: 0;
		max-width: 560px;
	}
	.eyebrow {
		font: 400 var(--fs-eyebrow) var(--face-data);
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: #d3b780;
	}
	h1 {
		margin: 0.14em 0 0.2em;
		color: #f4ecdc;
		font: italic 400 var(--fs-display-xl) / var(--lh-display, 0.92) var(--face-display);
		letter-spacing: var(--tracking-display, -0.025em);
		overflow-wrap: break-word;
	}
	.room-title p {
		max-width: 400px;
		margin: 0;
		color: var(--text-2);
		font-size: var(--fs-body);
	}
	.room-tools {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-top: var(--space-3);
	}
	/* Wide screens: the title in its own column, the stage beside it. */
	@media (min-width: 1100px) {
		.room {
			grid-template-columns: minmax(300px, 0.8fr) minmax(0, 1.2fr);
		}
	}
	/* Narrower: the title on top, the stage as a full-width band right under it. */
	@media (max-width: 1099px) {
		.room {
			align-items: start;
			min-height: 0;
		}
		.room-title {
			max-width: 760px;
		}
		.room-title p {
			max-width: 560px;
		}
	}
	@media (max-width: 760px) {
		.room {
			padding-block: 18px 16px;
		}
		h1 {
			font-size: var(--fs-display-l);
		}
		.room-tools {
			margin-top: var(--space-2);
		}
	}
	@media (max-width: 480px) {
		h1 {
			font-size: var(--fs-display-m);
		}
		.room-title p {
			display: none;
		}
	}
</style>
