<!--
	Curva art layer (FUX.ART · homage: Robert Moog). Decorative only, under the page content.
	- Hero: an oscillator wave (sine, saw, square) that draws itself once; the transistor-ladder
	  patent schematic as a faint watermark; two patch cables that plug into hero jacks and drop
	  behind the rack (wide screens).
	- Down the page: a Eurorack rail with screws in every gap between modules, and patch cables
	  that plug in (stroke draw plus a small swing on --ease-mech) when their gap scrolls into
	  view; the last one drops toward the footer homage. Engraved waveforms run down both gutters.
	- A slow lamp glow behind the deepest open module (the rack, the filter bank or the cabinet).
	Where the sections sit is read from the page root (its in-flow children) on every resize.
	Heavy shapes are static files in /art/curva/. Paused off-screen and on hidden tabs
	(artVisibility, per motif); nothing moves under prefers-reduced-motion (final frame shown).
	Rules: docs/plans/fux-art-brief.md · contract: ./README.md.
-->
<script lang="ts">
	import type { Attachment } from 'svelte/attachments';
	import { artVisibility } from './visibility.ts';

	interface Box {
		top: number;
		bottom: number;
		left: number;
		width: number;
	}

	let boxes = $state.raw<Box[]>([]);
	let height = $state(0);

	/** Reads the page sections (the root's in-flow children) whenever the root changes size. */
	const measure: Attachment<HTMLElement> = (layer) => {
		const root = layer.parentElement;
		if (!root || typeof ResizeObserver !== 'function') return;
		const observer = new ResizeObserver(() => {
			const next: Box[] = [];
			for (const child of root.children) {
				if (child === layer || !(child instanceof HTMLElement)) continue;
				if (child.offsetParent !== root || child.offsetHeight < 40) continue;
				const top = child.offsetTop;
				next.push({
					top,
					bottom: top + child.offsetHeight,
					left: child.offsetLeft,
					width: child.offsetWidth
				});
			}
			boxes = next;
			height = root.clientHeight;
		});
		observer.observe(root);
		return () => observer.disconnect();
	};

	/** Where the rack starts: the hero art ends there and its cables drop behind it. */
	const heroEnd = $derived(boxes.length > 1 ? boxes[1].top : 0);
	/** The middle of every gap between sections, then of the bottom padding (toward the homage). */
	const gaps = $derived.by(() => {
		const ys: number[] = [];
		let above: Box | undefined;
		for (const box of boxes) {
			if (above) ys.push((above.bottom + box.top) / 2);
			above = box;
		}
		if (above && height - above.bottom > 8) ys.push((above.bottom + height) / 2);
		return ys;
	});
	/** The deepest open module: the section just above the lower panels. */
	const active = $derived(boxes.length > 2 ? boxes[boxes.length - 2] : undefined);
</script>

<div class="art-layer" aria-hidden="true" {@attach artVisibility} {@attach measure}>
	{#if active}
		<div
			class="cv-lamp-box"
			style:top="{active.top}px"
			style:left="{active.left}px"
			style:width="{active.width}px"
			style:height="{active.bottom - active.top}px"
			{@attach artVisibility}
		>
			<div class="cv-lamp"></div>
		</div>
	{/if}
	{#if heroEnd}
		<div class="cv-gutter cv-gutter-l" style:top="{heroEnd}px"></div>
		<div class="cv-gutter cv-gutter-r" style:top="{heroEnd}px"></div>
	{/if}
	<div class="cv-hero" style:height={heroEnd ? `${heroEnd}px` : undefined} {@attach artVisibility}>
		<div class="cv-ladder"></div>
		<svg class="cv-wave" viewBox="0 0 820 120">
			<path
				class="cv-draw"
				pathLength="1"
				d="M0 60C10.9 41.1 20.8 24 32.5 24S54.1 41.1 65 60S85.8 96 97.5 96S119.1 78.9 130 60S150.8 24 162.5 24S184.1 41.1 195 60S215.8 96 227.5 96S249.1 78.9 260 60L300 24V96L380 24V96L460 24V96L500 60V24H550V96H600V24H650V96H700V24H750V96H800V60H820"
			/>
		</svg>
		<svg class="cv-jacks" viewBox="0 0 240 300">
			<circle class="cv-nut" cx="70" cy="44" r="9" />
			<circle class="cv-nut" cx="123" cy="30" r="9" />
			<circle class="cv-nut" cx="176" cy="38" r="9" />
			<circle class="cv-hole" cx="123" cy="30" r="3.5" />
			<g class="cv-swing cv-ja">
				<path class="cv-cord cv-draw" pathLength="1" d="M70 58C70 150 26 196 34 300" />
				<path class="cv-plug" d="M70 44v14" />
			</g>
			<g class="cv-swing cv-jb">
				<path class="cv-cord cv-draw cv-cream" pathLength="1" d="M176 52C176 140 230 180 222 300" />
				<path class="cv-plug" d="M176 38v14" />
			</g>
		</svg>
	</div>
	{#each gaps as y, index (index)}
		<div class="cv-gap" class:cv-alt={index % 2 === 0} style:top="{y}px" {@attach artVisibility}>
			<div class="cv-rail"></div>
			{#if index > 0}
				<svg class="cv-c1" viewBox="0 0 360 80">
					<g class="cv-swing">
						<path class="cv-cord cv-draw" pathLength="1" d="M10 8C100 74 260 74 350 8" />
					</g>
				</svg>
				<svg class="cv-c2" viewBox="0 0 360 80">
					<g class="cv-swing">
						<path class="cv-cord cv-draw cv-cream" pathLength="1" d="M10 6C130 10 200 74 350 78" />
					</g>
				</svg>
			{/if}
		</div>
	{/each}
</div>

<style>
	.art-layer {
		/* Motion tokens with their tokens.css values as fallbacks: one unresolved var() would make
		   the whole `animation` shorthand invalid, and nothing would move. */
		--cv-scene: var(--dur-scene, 0.72s);
		--cv-out: var(--ease-out, cubic-bezier(0.2, 0.8, 0.2, 1));
		--cv-mech: var(--ease-mech, cubic-bezier(0.3, 1.4, 0.5, 1));
		--cv-in-out: var(--ease-in-out, cubic-bezier(0.65, 0, 0.35, 1));
		position: absolute;
		inset: 0;
		z-index: -1;
		pointer-events: none;
		overflow: hidden;
	}

	/* Lamp: a warm halo bleeding out around the deepest open module (only its edges show). */
	.cv-lamp-box {
		position: absolute;
	}
	.cv-lamp {
		position: absolute;
		inset: 0;
		border-radius: var(--rad-lg);
		box-shadow: 0 0 44px 6px color-mix(in srgb, var(--accent) 28%, transparent);
		opacity: 0.7;
	}

	/* Engraved oscillator waveforms (sine, saw, square) down both gutters. */
	.cv-gutter {
		position: absolute;
		bottom: 0;
		width: 16px;
		background: url('/art/curva/gutter.svg') 0 0 / 16px 240px repeat-y;
	}
	.cv-gutter-l {
		left: 4px;
	}
	.cv-gutter-r {
		right: 4px;
	}

	/* Hero: the band above the rack (its height is the rack's top once measured). */
	.cv-hero {
		position: absolute;
		top: 0;
		right: 0;
		left: 0;
		height: 300px;
	}
	.cv-ladder {
		position: absolute;
		top: 4%;
		left: 41%;
		width: 22%;
		height: 92%;
		background: url('/art/curva/ladder.svg') center / contain no-repeat;
		opacity: 0.07;
	}
	.cv-wave {
		position: absolute;
		top: 18px;
		left: 24%;
		width: 56%;
		height: auto;
		overflow: visible;
		filter: drop-shadow(0 0 6px color-mix(in srgb, var(--accent) 45%, transparent));
	}
	.cv-wave path {
		fill: none;
		stroke: var(--accent);
		stroke-width: 2.2;
		stroke-linecap: round;
		stroke-linejoin: round;
		opacity: 0.5;
	}
	/* Jacks and their cables sit right of the nameplate, only where it fits on one row. */
	.cv-jacks {
		position: absolute;
		right: 1.5%;
		bottom: -60px;
		display: none;
		width: 240px;
		height: 300px;
		overflow: visible;
		opacity: 0.85;
	}
	.cv-nut {
		fill: #0a0a09;
		stroke: #8f8b83;
		stroke-width: 2.4;
	}
	.cv-hole {
		fill: #000;
	}
	.cv-plug {
		stroke: #d9d4c8;
		stroke-width: 7;
		stroke-linecap: round;
	}
	.cv-cord {
		fill: none;
		stroke: var(--accent);
		stroke-width: 3.4;
		stroke-linecap: round;
	}
	.cv-cord.cv-cream {
		stroke: var(--text-2);
	}
	.cv-swing {
		transform-box: view-box;
		transform-origin: 180px 0;
	}
	.cv-ja {
		transform-origin: 70px 44px;
	}
	.cv-jb {
		transform-origin: 176px 38px;
	}

	/* Gaps between modules: a rail, and below the rack two hanging patch cables. The cable box
	   starts 36px behind the module above, so only the sag inside the gap shows. */
	.cv-gap {
		position: absolute;
		right: 0;
		left: 0;
		height: 0;
	}
	.cv-rail {
		position: absolute;
		top: -7px;
		right: 0;
		left: 0;
		height: 14px;
		background: url('/art/curva/rail.svg') 0 0 / 160px 14px repeat-x;
		opacity: 0.8;
	}
	.cv-gap svg {
		position: absolute;
		top: -48px;
		width: 360px;
		height: 80px;
		overflow: visible;
		opacity: 0.85;
	}
	.cv-c1 {
		left: 6%;
	}
	.cv-c2 {
		left: 58%;
	}
	/* Every other gap: cables shifted, the crossing one mirrored (it runs the other way). */
	.cv-alt .cv-c1 {
		left: 30%;
	}
	.cv-alt .cv-c2 {
		left: 64%;
		transform: scaleX(-1);
	}
	.cv-alt .cv-c1 .cv-cord {
		stroke: var(--text-2);
	}
	.cv-alt .cv-c2 .cv-cord {
		stroke: var(--accent-hi, var(--accent));
	}

	@media (min-width: 1281px) {
		.cv-jacks {
			display: block;
		}
	}
	@media (max-width: 720px) {
		.cv-gutter,
		.cv-ladder,
		.cv-c2 {
			display: none;
		}
		.cv-wave {
			top: 44px;
			left: 46%;
			width: 52%;
		}
		.cv-c1,
		.cv-alt .cv-c1 {
			left: 4%;
		}
	}

	/* Motion: one-shot reveals when a motif is first seen, a slow lamp; never under reduce. */
	@media (prefers-reduced-motion: no-preference) {
		.cv-draw {
			stroke-dasharray: 1 2;
			stroke-dashoffset: 1.01;
		}
		.cv-plug {
			opacity: 0;
		}
		:global(.cv-hero[data-art-seen]) .cv-wave path {
			animation: cv-draw 2.4s var(--cv-out) 0.2s forwards;
		}
		:global(.cv-hero[data-art-seen]) .cv-swing,
		:global(.cv-gap[data-art-seen]) .cv-swing {
			animation: cv-swing calc(var(--cv-scene) * 2) var(--cv-mech) 0.15s both;
		}
		:global(.cv-hero[data-art-seen]) .cv-plug {
			animation: cv-plug var(--cv-scene) var(--cv-mech) forwards;
		}
		:global(.cv-hero[data-art-seen]) .cv-cord,
		:global(.cv-gap[data-art-seen]) .cv-cord {
			animation: cv-draw 1.1s var(--cv-out) 0.2s forwards;
		}
		:global(.cv-hero[data-art-seen]) .cv-jb,
		:global(.cv-hero[data-art-seen]) .cv-jb .cv-plug,
		:global(.cv-gap[data-art-seen]) .cv-c2 .cv-swing {
			animation-delay: 0.4s;
		}
		:global(.cv-hero[data-art-seen]) .cv-jb .cv-cord,
		:global(.cv-gap[data-art-seen]) .cv-c2 .cv-cord {
			animation-delay: 0.45s;
		}
		.cv-lamp {
			animation: cv-lamp 9s var(--cv-in-out) infinite alternate;
		}
	}
	@keyframes cv-draw {
		to {
			stroke-dashoffset: 0;
		}
	}
	@keyframes cv-swing {
		from {
			transform: rotate(-6deg);
		}
	}
	@keyframes cv-plug {
		from {
			transform: translateY(12px);
			opacity: 0;
		}
		to {
			transform: none;
			opacity: 1;
		}
	}
	@keyframes cv-lamp {
		from {
			opacity: 0.35;
		}
		to {
			opacity: 1;
		}
	}
	:global([data-art='paused']) * {
		animation-play-state: paused !important;
	}
	@media (prefers-reduced-motion: reduce) {
		.art-layer * {
			animation: none !important;
		}
	}
</style>
