<!--
	Cabo (Ray Dolby), FUX.ART.2. Decorative only: hidden from assistive technology, no text,
	no pointer events, nothing focusable. Dolby noise reduction is a compander around the tape:
	the encoder lifts quiet high-frequency passages before recording (compression in) and the
	decoder lowers them by the same amount on playback (expansion out), taking the hiss down
	with them. Motifs, top to bottom: the tape with its level-dependent pre-emphasis, the
	noise-reduction block diagram (watermark), the compander plate whose two curves draw in
	once, a soft LCD glow over the rack, and the brushed cabinet posts of the 19" rack, whose
	screws catch one light sweep as they scroll in. The coils stay still: U4's reels show the
	real write state, so nothing here moves like tape or looks like progress or a meter.
	Contrast: the plate sits between the intro's paragraph column and its meta column (on
	mobile it fades out before the paragraph), the watermark sits beside the title at 0.14 and
	the glow tops out at 16 % accent, which keeps the paragraph above 5:1.
	Rules: ./README.md and docs/plans/fux-art-brief.md.
-->
<script lang="ts">
	import { artVisibility } from '#lib/components/art/visibility.ts';
</script>

<div class="art-layer" aria-hidden="true" data-art="paused" {@attach artVisibility}>
	<div class="tape"></div>
	<div class="hero" data-art="paused" {@attach artVisibility}>
		<div class="diagram"></div>
		<div class="glow"></div>
		<div class="plate">
			<i class="screw"></i><i class="screw"></i>
			<div class="grid"></div>
			<svg class="curves" viewBox="0 0 600 240">
				<path
					class="enc"
					pathLength="1"
					d="M20 187L160 137C210 119 250 111 300 103S380 92 420 77L580 20"
				/>
				<path
					class="dec"
					pathLength="1"
					d="M112 220L252 170C303 152 325 138 348 120S378 91 420 77L580 20"
				/>
			</svg>
		</div>
	</div>
	<div class="post l"></div>
	<div class="post r"></div>
	<i class="coil l"></i>
	<i class="coil r"></i>
	<div class="bolts b1" data-art="paused" {@attach artVisibility}>
		<i class="screw"></i><i class="screw"></i>
	</div>
	<div class="bolts b2" data-art="paused" {@attach artVisibility}>
		<i class="screw"></i><i class="screw"></i>
	</div>
	<div class="bolts b3" data-art="paused" {@attach artVisibility}>
		<i class="screw"></i><i class="screw"></i>
	</div>
	<div class="bolts b4" data-art="paused" {@attach artVisibility}>
		<i class="screw"></i><i class="screw"></i>
	</div>
</div>

<style>
	.art-layer {
		/* The intro and the rack share a 1380px frame inside the room's 22px padding. */
		--fl: max(22px, 50% - 690px);
		position: absolute;
		inset: 0;
		z-index: -1;
		overflow: hidden;
		pointer-events: none;
	}
	.art-layer div,
	.art-layer i {
		position: absolute;
	}

	/* Tape across the top: encode boosts above the centre line, decode cuts below it. */
	.tape {
		top: 2px;
		left: 0;
		right: 0;
		height: 28px;
		background: url('/art/cabo/tape.svg') 0 0 / 480px 28px repeat-x;
		opacity: 0.5;
		mask: linear-gradient(90deg, transparent, #000 15%, #000 85%, transparent);
	}

	.hero {
		top: 0;
		left: 0;
		right: 0;
		height: 240px;
	}
	/* Encoder (side chain adds) → tape → decoder (side chain subtracts), beside the title and
	   above the paragraph. */
	.diagram {
		left: calc(var(--fl) + 170px);
		top: 30px;
		width: min(420px, 36%);
		aspect-ratio: 560 / 96;
		background: var(--accent);
		mask: url('/art/cabo/nr-diagram.svg') 0 0 / 100% 100% no-repeat;
		opacity: 0.14;
	}
	/* Light from the rack's LCDs leaking over its top edge; it only breathes, it never reads. */
	.glow {
		--glow: color-mix(in srgb, var(--accent) 16%, transparent);
		right: var(--fl);
		top: 60px;
		width: min(720px, 60%);
		height: 200px;
		background: radial-gradient(closest-side, var(--glow), transparent);
		opacity: 0.7;
		animation: lcd 9s var(--ease-in-out, ease-in-out) infinite alternate;
	}
	/* Compander plate, between the paragraph column (640px) and the meta column (250px). */
	.plate {
		top: 36px;
		right: calc(var(--fl) + 250px);
		width: min(440px, calc(100% - 2 * var(--fl) - 910px));
		aspect-ratio: 5 / 2;
		border-radius: var(--rad-lg);
		background: repeating-linear-gradient(90deg, #ffffff06 0 1px, transparent 1px 4px);
		box-shadow:
			inset 0 0 0 1px var(--rule),
			var(--elev-1);
	}
	.plate .screw {
		top: 8px;
		left: 8px;
	}
	.plate .screw + .screw {
		left: auto;
		right: 8px;
	}
	.grid {
		inset: 8px;
		background: var(--accent);
		mask: url('/art/cabo/compander-grid.svg') 0 0 / 100% 100% no-repeat;
		opacity: 0.22;
	}
	.curves {
		position: absolute;
		left: 8px;
		top: 8px;
		width: calc(100% - 16px);
		height: calc(100% - 16px);
		overflow: visible;
	}
	.curves path {
		fill: none;
		stroke: var(--accent);
		stroke-width: 2.5;
		stroke-dasharray: 1;
		stroke-dashoffset: 1;
		opacity: 0.4;
	}
	.curves .dec {
		stroke: var(--accent-hi);
		opacity: 0.34;
	}
	.hero:global([data-art-seen]) .enc {
		animation: draw 1.6s var(--ease-in-out, ease-in-out) 0.3s both;
	}
	.hero:global([data-art-seen]) .dec {
		animation: draw 1.6s var(--ease-in-out, ease-in-out) 1.2s both;
	}

	.screw {
		width: 13px;
		height: 13px;
		overflow: hidden;
		border-radius: 50%;
		background: radial-gradient(circle at 35% 30%, #ffffffb3, transparent 55%), var(--mat-metal);
		box-shadow:
			var(--bevel),
			0 1px 2px #000a;
	}
	.screw::before,
	.screw::after {
		content: '';
		position: absolute;
	}
	.screw::before {
		left: 2px;
		right: 2px;
		top: 5.5px;
		height: 2px;
		background: #3a3d3b;
		transform: rotate(30deg);
	}
	.screw + .screw::before {
		transform: rotate(-55deg);
	}
	/* The sheen waits off the head and crosses it once. */
	.screw::after {
		inset: -3px;
		background: linear-gradient(105deg, transparent 30%, #ffffffd9 50%, transparent 70%);
		transform: translateX(-140%);
	}
	.hero:global([data-art-seen]) .screw::after {
		animation: sheen 1.1s var(--ease-out, ease-out) 2.6s both;
	}
	.hero:global([data-art-seen]) .screw + .screw::after {
		animation-delay: 2.85s;
	}

	/* Cabinet posts just outside the rack's ring (rack half width 690px + 10px ring). */
	.post {
		display: none;
		top: 150px;
		bottom: 40px;
		width: 56px;
		background: url('/art/cabo/post.svg') 0 0 / 56px 66px repeat-y;
		opacity: 0.5;
		mask: linear-gradient(transparent, #000 140px, #000 calc(100% - 140px), transparent);
	}
	.post.l {
		right: calc(50% + 700px);
	}
	.post.r {
		left: calc(50% + 700px);
	}
	/* Each band holds the two screws of one rack unit hole (1U = 66px, middle hole at 33px).
	   The band itself sits 160px below its screws, so with the shared 120px root margin it
	   only counts as seen once the screws are on screen. */
	.bolts {
		display: none;
		left: 0;
		right: 0;
		height: 1px;
	}
	.bolts .screw {
		top: -160px;
		right: calc(50% + 721.5px);
	}
	.bolts .screw + .screw {
		right: auto;
		left: calc(50% + 721.5px);
	}
	.b1 {
		top: calc(150px + 26.5px + 6 * 66px + 160px);
	}
	.b2 {
		top: calc(150px + 26.5px + 20 * 66px + 160px);
	}
	.b3 {
		top: calc(150px + 26.5px + 34 * 66px + 160px);
	}
	.b4 {
		top: calc(150px + 26.5px + 48 * 66px + 160px);
	}
	.bolts:global([data-art-seen]) .screw::after {
		animation: sheen 1.1s var(--ease-out, ease-out) 0.3s both;
	}
	.bolts:global([data-art-seen]) .screw + .screw::after {
		animation-delay: 0.5s;
	}
	/* Still coils of tape in the wide gutters, level with U4: no rotation, no drift. */
	.coil {
		display: none;
		width: 150px;
		aspect-ratio: 1;
		background: var(--text-2);
		mask: url('/art/cabo/coil.svg') 0 0 / 100% 100% no-repeat;
		opacity: 0.12;
	}
	.coil.l {
		top: 52%;
		right: calc(50% + 790px);
		transform: rotate(-18deg);
	}
	.coil.r {
		top: 61%;
		left: calc(50% + 790px);
		transform: rotate(32deg);
	}

	@keyframes draw {
		from {
			stroke-dashoffset: 1;
		}
		to {
			stroke-dashoffset: 0;
		}
	}
	@keyframes sheen {
		from {
			transform: translateX(-140%);
		}
		to {
			transform: translateX(140%);
		}
	}
	@keyframes lcd {
		from {
			opacity: 0.45;
		}
		to {
			opacity: 0.9;
		}
	}

	@media (min-width: 1420px) {
		.post {
			display: block;
		}
	}
	@media (min-width: 1500px) {
		.bolts {
			display: block;
		}
	}
	@media (min-width: 1760px) {
		.coil {
			display: block;
		}
	}
	/* Between the paragraph and the meta column there is no room for the plate here. */
	@media (min-width: 821px) and (max-width: 1239px) {
		.plate {
			display: none;
		}
	}
	/* Mobile: the plate moves beside the title and fades out before the paragraph. */
	@media (max-width: 820px) {
		.art-layer {
			--fl: 12px;
		}
		.diagram {
			display: none;
		}
		.plate {
			top: 28px;
			right: var(--fl);
			width: min(220px, calc(100% - 2 * var(--fl) - 150px));
			background: none;
			box-shadow: none;
			mask: linear-gradient(#000 45%, transparent 85%);
		}
		.curves path,
		.curves .dec {
			opacity: 0.3;
		}
		.glow {
			width: 90%;
		}
	}

	/* !important: every `animation` shorthand resets the play state to running, and the reveal
	   rules are more specific than this one. */
	:global([data-art='paused']) *,
	:global([data-art='paused']) *::after {
		animation-play-state: paused !important;
	}
	/* Final frame: both curves drawn, the glow at rest, the screws without sheen. */
	@media (prefers-reduced-motion: reduce) {
		.art-layer *,
		.art-layer *::before,
		.art-layer *::after {
			animation: none !important;
		}
		.curves path {
			stroke-dashoffset: 0;
		}
	}
</style>
