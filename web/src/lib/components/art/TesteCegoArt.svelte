<!--
	Teste cego art (FUX.ART.3; homage to Floyd Toole and Sean Olive: loudspeakers heard behind an
	acoustically transparent screen in a treated listening room, and the off-axis polar
	measurements that predicted which one listeners would prefer). It complements the curtain,
	light cone and wood of ListeningRoom and BlindTest without redrawing them. Two parts:

	- `place="scene"`, rendered by ListeningRoom inside its frame (the 1600 × 600 scene box),
	  right after the scene's SVG and before the plates: light rippling slowly across the curtain
	  folds, a polar grid with dispersion lobes (wide at low frequencies, narrow at high) that
	  expand once from the centre loudspeaker and then stay as a watermark, and a few light motes
	  drifting in the cone. It paints above the drawing and under the plates, the title, the cue
	  and the help, so no text is ever under it.
	- `place="page"` (default), the first child of BlindTest's root: quadratic-residue diffusers
	  along the desk's top and bottom padding and up its side padding, and a loudspeaker behind
	  grille cloth plus a dispersion watermark in the side gutters of wide screens. Its root makes
	  no stacking context, so it paints under the room and the desk; only the motif boxes rise
	  above the wood (z-index 1), and only inside the desk padding and the gutters, which hold no
	  text (the geometry mirrors BlindTest's `.desk` padding and 1360 px grid).

	Contract: art/README.md, with that documented deviation (the room and the desk are opaque, so
	a layer under them would never be seen). Nothing measures anything: the lobes are drawn once
	and then hold still (plan §0.12.7). Class names carry an `art-` prefix.
-->
<script lang="ts">
	import { artVisibility } from './visibility.ts';

	let { place = 'page' }: { place?: 'page' | 'scene' } = $props();
</script>

{#if place === 'scene'}
	<div class="art-layer art-scene" aria-hidden="true" data-art="paused" {@attach artVisibility}>
		<span class="art-ripple"></span>
		<span class="art-polar"></span>
		<svg class="art-lobes" viewBox="-170 -4 340 174" fill="none">
			<path style="--i:0" pathLength="1" d="M0 0a150 80 0 1 0 0 160a150 80 0 1 0 0-160" />
			<path style="--i:1" pathLength="1" d="M0 0a110 78 0 1 0 0 156a110 78 0 1 0 0-156" />
			<path style="--i:2" pathLength="1" d="M0 0a66 80 0 1 0 0 160a66 80 0 1 0 0-160" />
			<path style="--i:3" pathLength="1" d="M0 0a30 80 0 1 0 0 160a30 80 0 1 0 0-160" />
		</svg>
		<span class="art-motes">
			<i style="left:48%;top:22%;--s:4px;--dx:14px;--t:13s;--p:-2s"></i>
			<i style="left:53%;top:30%;--s:3px;--dx:-10px;--t:16s;--p:-9s"></i>
			<i style="left:44%;top:40%;--s:5px;--dx:12px;--t:18s;--p:-4s"></i>
			<i style="left:57%;top:46%;--s:3px;--dx:-16px;--t:12s;--p:-7s"></i>
			<i style="left:50%;top:55%;--s:6px;--dx:8px;--t:19s;--p:-12s"></i>
			<i style="left:41%;top:62%;--s:4px;--dx:18px;--t:15s;--p:-3s"></i>
			<i style="left:60%;top:66%;--s:3px;--dx:-12px;--t:17s;--p:-10s"></i>
			<i style="left:46%;top:74%;--s:5px;--dx:10px;--t:14s;--p:-6s"></i>
			<i style="left:55%;top:80%;--s:4px;--dx:-14px;--t:18s;--p:-15s"></i>
			<i style="left:38%;top:84%;--s:3px;--dx:16px;--t:13s;--p:-1s"></i>
		</span>
	</div>
{:else}
	<div class="art-layer art-page" aria-hidden="true" data-art="paused" {@attach artVisibility}>
		<div class="art-spacer"></div>
		<div class="art-desk">
			<span class="art-motif art-frieze art-frieze-top"></span>
			<span class="art-motif art-frieze art-frieze-bottom"></span>
			<span class="art-motif art-column art-column-l"></span>
			<span class="art-motif art-column art-column-r"></span>
			<span class="art-motif art-gutter art-gutter-l"></span>
			<span class="art-motif art-gutter art-gutter-r"></span>
		</div>
	</div>
{/if}

<style>
	.art-layer {
		position: absolute;
		inset: 0;
		overflow: hidden;
		pointer-events: none;
	}

	/* ---- Scene part: percentages of ListeningRoom's 1600 × 600 frame. ---- */
	.art-scene {
		contain: strict;
	}
	/* Light rippling on the curtain (y 40 to 468): two fold rhythms drifting against each other.
	   It goes away with the curtain when the result is revealed. */
	.art-ripple {
		position: absolute;
		inset: 6.667% 0 22%;
		overflow: hidden;
		mask-image: linear-gradient(transparent, black 20%, black 72%, transparent);
	}
	:global(.revealed) .art-ripple {
		opacity: 0;
	}
	.art-ripple::before,
	.art-ripple::after {
		content: '';
		position: absolute;
		inset: 0 -64px;
		background: var(--accent);
		mask-image: repeating-linear-gradient(
			90deg,
			transparent 0 18px,
			black 44px,
			transparent 70px 96px
		);
		opacity: 0.05;
	}
	.art-ripple::after {
		mask-image: repeating-linear-gradient(
			90deg,
			transparent 0 34px,
			black 58px,
			transparent 82px 140px
		);
		opacity: 0.035;
	}
	/* Polar grid and lobes share one box whose top centre is the centre loudspeaker (800, 250);
	   both fade out radially. */
	.art-polar,
	.art-lobes {
		position: absolute;
		left: 50%;
		top: 41.667%;
		width: 42.5%;
		aspect-ratio: 340 / 174;
		translate: -50% 0;
		mask-image: radial-gradient(50% 100% at 50% 0, black 50%, transparent);
	}
	.art-polar::before {
		content: '';
		position: absolute;
		inset: 0;
		background: var(--accent);
		mask-image: url('/art/teste-cego/polar.svg');
		mask-size: 100% 100%;
		mask-repeat: no-repeat;
		opacity: 0.08;
	}
	.art-lobes path {
		stroke: var(--accent);
		stroke-width: 0.8;
		stroke-dasharray: 1;
		opacity: 0.3;
		transform-box: view-box;
		transform-origin: 0 0;
	}
	/* Light motes in the cone (the room's own dust stays as it is). */
	.art-motes i {
		position: absolute;
		width: var(--s, 4px);
		height: var(--s, 4px);
		margin: calc(var(--s, 4px) / -2) 0 0 calc(var(--s, 4px) / -2);
		border-radius: 50%;
		background: radial-gradient(closest-side, var(--accent-hi, var(--accent)), transparent);
		opacity: 0.3;
	}

	/* ---- Page part: under the room and the desk; motif boxes only where there is no text. ---- */
	.art-page {
		display: flex;
		flex-direction: column;
	}
	/* Same height as ListeningRoom's `.room`: the desk starts right below it. */
	.art-spacer {
		flex: none;
		height: clamp(400px, 64vh, 660px);
	}
	.art-desk {
		/* BlindTest `.desk`: 4 px top border, padding 34 px / clamp(12px, 3vw, 40px) / 46 px. */
		--pad: clamp(12px, 3vw, 40px);
		position: relative;
		flex: 1 1 auto;
	}
	.art-motif {
		position: absolute;
		z-index: 1;
		background: var(--accent);
		mask-position: center;
		mask-size: contain;
		mask-repeat: no-repeat;
	}
	/* QRD diffuser friezes inside the top padding (4 to 38 px) and the bottom padding (46 px). */
	.art-frieze {
		left: 0;
		right: 0;
		height: 26px;
		mask-image: url('/art/teste-cego/diffuser.svg');
		mask-position: 0 0;
		mask-size: 168px 28px;
		mask-repeat: repeat-x;
		opacity: 0.1;
	}
	.art-frieze-top {
		top: 8px;
	}
	.art-frieze-bottom {
		bottom: 10px;
		scale: 1 -1;
	}
	/* Diffuser columns up the side padding, between the friezes. */
	.art-column {
		display: none;
		top: 38px;
		bottom: 46px;
		width: calc(var(--pad) - 10px);
		mask-image: url('/art/teste-cego/diffuser-v.svg');
		mask-position: 0 0;
		mask-size: 100% auto;
		mask-repeat: repeat-y;
		opacity: 0.09;
	}
	.art-column-l {
		left: 5px;
	}
	.art-column-r {
		right: 5px;
		scale: -1 1;
	}
	/* Side gutters of wide screens (outside the 1360 px desk grid). */
	.art-gutter {
		display: none;
		top: 16%;
		opacity: 0.08;
	}
	.art-gutter-l {
		left: calc((100% - 1360px) / 4 - 95px);
		width: 190px;
		height: 97px;
		mask-image: url('/art/teste-cego/dispersion.svg');
		rotate: -90deg;
	}
	.art-gutter-r {
		right: calc((100% - 1360px) / 4 - 50px);
		width: 100px;
		height: 158px;
		mask-image: url('/art/teste-cego/speaker.svg');
	}

	/* Motion (fux-art-brief §2): the lobes expand once when first seen; the ripple and the motes
	   are slow loops (≥ 12 s); everything holds still off-screen or with the tab hidden. Every
	   var() in a shorthand has a fallback, so a missing token never turns the animation off. */
	@media (prefers-reduced-motion: no-preference) {
		.art-ripple::before {
			animation: curtain-ripple 13s var(--ease-in-out, cubic-bezier(0.65, 0, 0.35, 1)) infinite
				alternate;
		}
		.art-ripple::after {
			animation: curtain-ripple 19s var(--ease-in-out, cubic-bezier(0.65, 0, 0.35, 1)) -6s infinite
				alternate-reverse;
		}
		.art-lobes path {
			animation: lobe-expand 2.4s var(--ease-out, cubic-bezier(0.2, 0.8, 0.2, 1))
				calc(var(--i, 0) * 280ms + 300ms) both paused;
		}
		.art-layer:global([data-art='running'][data-art-seen]) .art-lobes path {
			animation-play-state: running;
		}
		.art-motes i {
			opacity: 0;
			animation: mote-drift var(--t, 14s) var(--ease-in-out, cubic-bezier(0.65, 0, 0.35, 1))
				var(--p, 0s) infinite;
		}
	}
	.art-layer:global([data-art='paused']) *,
	.art-layer:global([data-art='paused']) *::before,
	.art-layer:global([data-art='paused']) *::after {
		animation-play-state: paused !important;
	}
	@keyframes curtain-ripple {
		to {
			transform: translateX(48px) scaleX(1.04);
		}
	}
	@keyframes lobe-expand {
		from {
			opacity: 0;
			transform: scale(0.18);
			stroke-dashoffset: 1;
		}
	}
	@keyframes mote-drift {
		0% {
			opacity: 0;
			transform: translate(0, 0);
		}
		30%,
		70% {
			opacity: 0.7;
		}
		100% {
			opacity: 0;
			transform: translate(var(--dx, 0px), -36px);
		}
	}

	/* Final frame: lobes drawn, curtain still, a few steady glints in the cone. */
	@media (prefers-reduced-motion: reduce) {
		.art-layer,
		.art-layer *,
		.art-layer *::before,
		.art-layer *::after {
			animation: none !important;
			transition: none !important;
		}
	}

	@media (min-width: 800px) and (max-width: 1679px) {
		.art-column {
			display: block;
		}
	}
	@media (min-width: 1680px) {
		.art-gutter {
			display: block;
		}
	}
	/* Mobile: the room keeps a 16:11 frame; half the motes. */
	@media (max-width: 760px) {
		.art-spacer {
			height: auto;
			aspect-ratio: 16 / 11;
			min-height: 250px;
		}
		.art-motes i:nth-child(n + 6) {
			display: none;
		}
	}
</style>
