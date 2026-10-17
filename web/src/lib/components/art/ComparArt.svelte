<!--
	Comparar art layer (FUX.ART · homage: Les Paul). Decorative only, laid on the cabinet's
	hammertone under its plates and panels (the cabinet is the page's opaque body).
	- Title: the intro plate echoed three times in track colours, sliding out one after another
	  (sound-on-sound: each pass laid over the last).
	- Down the page: the eight track colours run as tape along both cabinet edges; in every gap
	  between sections a strip of eight-track tape runs past a block of four heads (extra, erase,
	  record, play) once, when the gap scrolls into view.
	- Multitrack reels, etched dark into the metal, turn slowly while they are on screen.
	- Near the footer homage: the sound-on-sound tape path in line art; its feedback loop (extra
	  playback head → mix → record head) draws itself in.
	Where the sections sit is read from the cabinet (its in-flow children) on every resize. Heavy
	shapes are static files in /art/comparar/. Etched shapes are dark only, so the light text on
	the translucent panels never loses contrast. Paused off-screen and on hidden tabs
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

	/** Reads the cabinet sections (its in-flow children) whenever the cabinet changes size. */
	const measure: Attachment<HTMLElement> = (layer) => {
		const host = layer.parentElement;
		if (!host || typeof ResizeObserver !== 'function') return;
		const observer = new ResizeObserver(() => {
			const next: Box[] = [];
			for (const child of host.children) {
				if (child === layer || !(child instanceof HTMLElement)) continue;
				if (child.offsetParent !== host || child.offsetHeight < 40) continue;
				const top = child.offsetTop;
				next.push({
					top,
					bottom: top + child.offsetHeight,
					left: child.offsetLeft,
					width: child.offsetWidth
				});
			}
			boxes = next;
		});
		observer.observe(host);
		return () => observer.disconnect();
	};

	/** The intro plate, echoed by the title layers. */
	const intro = $derived(boxes.length > 0 ? boxes[0] : undefined);
	const echo = $derived(
		intro
			? `top:${intro.top}px;left:${intro.left}px;width:${intro.width}px;height:${intro.bottom - intro.top}px`
			: ''
	);
	/** The middle of every gap after the deck (the intro gap belongs to the echo). */
	const tapes = $derived.by(() => {
		const ys: number[] = [];
		for (let index = 2; index < boxes.length; index++) {
			const above = boxes[index - 1];
			const below = boxes[index];
			if (below.top - above.bottom >= 8) ys.push((above.bottom + below.top) / 2);
		}
		return ys;
	});
	/** The last section (export), right above the footer homage. */
	const last = $derived(boxes.length > 2 ? boxes[boxes.length - 1] : undefined);
</script>

<div class="art-layer" aria-hidden="true" {@attach artVisibility} {@attach measure}>
	<div class="ca-side ca-left"></div>
	<div class="ca-side ca-right"></div>
	<div class="ca-reel ca-r1" {@attach artVisibility}><div class="ca-disc"></div></div>
	<div class="ca-reel ca-r2" {@attach artVisibility}><div class="ca-disc"></div></div>
	{#if last}
		<div class="ca-reel ca-r3" style:top="{last.top + 40}px" {@attach artVisibility}>
			<div class="ca-disc"></div>
		</div>
		<div class="ca-sos" style:top="{last.bottom - 217}px" {@attach artVisibility}>
			<svg viewBox="0 0 340 220">
				<path class="ca-loop" pathLength="1" d="M117 148V186H161M179 186H197V150" />
			</svg>
		</div>
	{/if}
	{#each tapes as y, index (index)}
		<div class="ca-gap" style:top="{y}px" {@attach artVisibility}>
			<div class="ca-tape"></div>
		</div>
	{/each}
	{#if intro}
		<div class="ca-echo ca-e1" style={echo}></div>
		<div class="ca-echo ca-e2" style={echo}></div>
		<div class="ca-echo ca-e3" style={echo}></div>
	{/if}
</div>

<style>
	.art-layer {
		/* Motion tokens with their tokens.css values as fallbacks: one unresolved var() would make
		   the whole `animation` shorthand invalid, and nothing would move. */
		--ca-scene: var(--dur-scene, 0.72s);
		--ca-out: var(--ease-out, cubic-bezier(0.2, 0.8, 0.2, 1));
		--ca-mech: var(--ease-mech, cubic-bezier(0.3, 1.4, 0.5, 1));
		position: absolute;
		inset: 0;
		z-index: -1;
		pointer-events: none;
		overflow: hidden;
		border-radius: inherit;
	}

	/* Track-coloured tape along both cabinet edges, in the cabinet's padding. */
	.ca-side {
		position: absolute;
		top: 14px;
		bottom: 14px;
		width: 12px;
		background: url('/art/comparar/tape-v.svg') 0 0 / 12px 40px repeat-y;
		opacity: 0.42;
	}
	.ca-left {
		left: 4px;
	}
	.ca-right {
		right: 4px;
	}

	/* Reels etched into the hammertone, half off the cabinet edges. */
	.ca-reel {
		position: absolute;
		width: 440px;
		height: 440px;
	}
	.ca-r1 {
		top: 9%;
		right: -220px;
	}
	.ca-r2 {
		top: 47%;
		left: -200px;
	}
	.ca-r3 {
		right: -230px;
	}
	.ca-disc {
		width: 100%;
		height: 100%;
		background: url('/art/comparar/reel.svg') center / contain no-repeat;
	}

	/* Sound-on-sound diagram: the empty foot of the export panel's left column. */
	.ca-sos {
		position: absolute;
		left: 36px;
		display: none;
		width: 280px;
		height: 181px;
		background: url('/art/comparar/sos.svg') 0 0 / contain no-repeat;
	}
	.ca-sos svg {
		display: block;
		width: 100%;
		height: 100%;
		overflow: visible;
	}
	.ca-loop {
		fill: none;
		stroke: var(--accent);
		stroke-width: 2.6;
		stroke-linecap: round;
		stroke-linejoin: round;
		opacity: 0.75;
	}

	/* Gap tape: eight track stripes running past a four-head block. */
	.ca-gap {
		position: absolute;
		right: 0;
		left: 0;
		height: 0;
	}
	.ca-gap::after {
		content: '';
		position: absolute;
		top: -8px;
		left: 68%;
		width: 52px;
		height: 16px;
		background: url('/art/comparar/heads.svg') 0 0 / 52px 16px no-repeat;
	}
	.ca-tape {
		position: absolute;
		top: -6px;
		right: 0;
		left: -160px;
		height: 12px;
		background: url('/art/comparar/tape.svg') 0 0 / 40px 12px repeat-x;
		opacity: 0.6;
	}

	/* Title echo: the intro plate laid again, offset and fading, pass after pass. */
	.ca-echo {
		position: absolute;
		border: 1.5px solid;
		border-radius: 6px;
		transform: translate(calc(var(--k) * 5px), calc(var(--k) * 4px));
	}
	.ca-e1 {
		--k: 1;
		border-color: color-mix(in srgb, #f2b33d 70%, transparent);
		background: color-mix(in srgb, #f2b33d 10%, transparent);
	}
	.ca-e2 {
		--k: 2;
		border-color: color-mix(in srgb, #72c6b2 55%, transparent);
		background: color-mix(in srgb, #72c6b2 7%, transparent);
	}
	.ca-e3 {
		--k: 3;
		border-color: color-mix(in srgb, #d99bce 40%, transparent);
		background: color-mix(in srgb, #d99bce 5%, transparent);
	}

	@media (min-width: 1181px) {
		.ca-sos {
			display: block;
		}
	}
	@media (max-width: 640px) {
		.ca-side {
			display: none;
		}
		.ca-reel {
			width: 260px;
			height: 260px;
		}
		.ca-r1,
		.ca-r3 {
			right: -130px;
		}
		.ca-r2 {
			left: -130px;
		}
	}

	/* Motion: one-shot reveals when a motif is first seen, reels while on screen; never under
	   reduce. */
	@media (prefers-reduced-motion: no-preference) {
		.ca-disc {
			animation: ca-spin 56s linear infinite;
		}
		.ca-r2 .ca-disc {
			animation-duration: 72s;
		}
		.ca-r3 .ca-disc {
			animation-duration: 64s;
		}
		.ca-gap:global([data-art-seen]) > .ca-tape {
			animation: ca-run 2.8s cubic-bezier(0.15, 0.6, 0.3, 1) both;
		}
		.ca-loop {
			stroke-dasharray: 1 2;
			stroke-dashoffset: 1.01;
		}
		:global(.ca-sos[data-art-seen]) .ca-loop {
			animation: ca-draw 1.8s var(--ca-out) 0.3s forwards;
		}
		.art-layer:global(:not([data-art-seen])) > .ca-echo {
			opacity: 0;
		}
		.art-layer:global([data-art-seen]) > .ca-echo {
			animation: ca-echo calc(var(--ca-scene) * 1.6) var(--ca-mech) both;
			animation-delay: calc(var(--k) * 140ms + 200ms);
		}
	}
	@keyframes ca-spin {
		to {
			transform: rotate(1turn);
		}
	}
	@keyframes ca-run {
		from {
			transform: translateX(0);
		}
		to {
			transform: translateX(160px);
		}
	}
	@keyframes ca-draw {
		to {
			stroke-dashoffset: 0;
		}
	}
	@keyframes ca-echo {
		from {
			transform: none;
			opacity: 0;
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
