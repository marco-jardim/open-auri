<!--
	Soe como X (Andy Hildebrand), FUX.ART.2. Decorative only: hidden from assistive technology,
	no text, no pointer events, nothing focusable. Before pitch correction, Hildebrand read
	seismic data for oil exploration: a shot sends a wave into the ground, a line of geophones
	records the echoes from the strata and the interpreter picks the arrivals. The same signal
	processing later found the pitch of a voice and snapped it to the nearest note. Motifs, top
	to bottom: the geophone line, a picked trace that draws itself across the hero, well logs
	down both edges, folded strata cut by a fault (light scroll parallax, transform only) under
	a slow shot wavefront, and a piano roll whose quantized notes snap onto the semitone lines.
	The chassis and its station panels are opaque and sit above this layer, so the art stays
	behind them. Contrast: the trace tops out at 0.3 accent (pink text on it keeps 5:1); the
	strata are flattened at 0.32 so their brightest band keeps --muted text at 4.6:1.
	Rules: ./README.md and docs/plans/fux-art-brief.md.
-->
<script lang="ts">
	import { artVisibility } from '#lib/components/art/visibility.ts';
</script>

<div class="art-layer" aria-hidden="true" data-art="paused" {@attach artVisibility}>
	<div class="geo"></div>
	<div class="hero" data-art="paused" {@attach artVisibility}>
		<div class="win"><div class="trace"></div></div>
	</div>
	<div class="log l"></div>
	<div class="log r"></div>
	<div class="ground" data-art="paused" {@attach artVisibility}>
		<div class="strata">
			<i class="stratum s1"></i><i class="stratum s2"></i><i class="stratum s3"></i>
		</div>
		<div class="shot"><i class="wave"></i><i class="wave"></i></div>
	</div>
	<div class="roll" data-art="paused" {@attach artVisibility}>
		<svg viewBox="0 0 480 140">
			<rect x="10" y="87" width="50" height="6" rx="3" />
			<rect x="64" y="57" width="44" height="6" rx="3" />
			<rect x="112" y="77" width="38" height="6" rx="3" />
			<rect x="154" y="37" width="60" height="6" rx="3" />
			<rect x="218" y="57" width="34" height="6" rx="3" />
			<rect x="256" y="17" width="44" height="6" rx="3" />
			<rect x="304" y="37" width="46" height="6" rx="3" />
			<rect x="354" y="57" width="46" height="6" rx="3" />
			<rect x="404" y="37" width="66" height="6" rx="3" />
		</svg>
	</div>
</div>

<style>
	.art-layer {
		position: absolute;
		inset: 0;
		z-index: -1;
		overflow: hidden;
		pointer-events: none;
	}
	.art-layer div,
	.art-layer i,
	.art-layer svg {
		position: absolute;
	}

	/* Geophones on their cable, in the page's top padding. */
	.geo {
		top: 12px;
		left: 24px;
		right: 24px;
		height: 24px;
		background: var(--muted);
		mask: url('/art/soe-como-x/geophones.svg') 0 0 / 96px 24px repeat-x;
		opacity: 0.45;
	}

	/* The picked trace is revealed by a window sliding in from the left while the trace slides
	   back by the same amount: the trace never moves, it appears from left to right like a
	   recorder pen, with a soft glow at the moving edge. Transform and opacity only. */
	.hero {
		top: 112px;
		left: 0;
		right: 0;
		height: 100px;
	}
	.win {
		inset: 0;
		overflow: hidden;
		transform: translateX(-100%);
	}
	.trace {
		inset: 0;
		background: var(--accent-hi);
		mask: url('/art/soe-como-x/trace.svg') 24px 0 / calc(100% - 48px) 100% no-repeat;
		opacity: 0.3;
		transform: translateX(100%);
	}
	.win::after {
		--pen: color-mix(in srgb, var(--accent-hi) 40%, transparent);
		content: '';
		position: absolute;
		top: 0;
		bottom: 0;
		right: 0;
		width: 48px;
		background: radial-gradient(farthest-side at 100% 50%, var(--pen), transparent);
		opacity: 0;
	}
	.hero:global([data-art-seen]) .win {
		animation: wipe 2.8s var(--ease-in-out, ease-in-out) 0.3s both;
	}
	.hero:global([data-art-seen]) .trace {
		animation: unwipe 2.8s var(--ease-in-out, ease-in-out) 0.3s both;
	}
	.hero:global([data-art-seen]) .win::after {
		animation: pen 2.8s linear 0.3s both;
	}

	/* Well logs down both gutters, beside the chassis. */
	.log {
		top: 300px;
		bottom: 340px;
		width: 16px;
		background: var(--text-2);
		mask:
			url('/art/soe-como-x/well-log.svg') 0 0 / 16px 240px repeat-y,
			linear-gradient(transparent, #000 160px, #000 calc(100% - 160px), transparent);
		mask-composite: intersect;
		opacity: 0.16;
	}
	.log.l {
		left: 4px;
	}
	.log.r {
		right: 4px;
		transform: scaleX(-1);
	}

	.ground {
		left: 0;
		right: 0;
		bottom: 0;
		height: 300px;
	}
	/* One opacity for the whole stack: the layers are opaque inside it, so they never add up. */
	.strata {
		inset: 100px 0 0;
		opacity: 0.32;
		mask: linear-gradient(transparent, #000 50%);
	}
	.stratum {
		inset: 0;
		background: 0 0 / 100% 100% no-repeat;
	}
	/* The far layer lags the scroll and the near one leads it: depth without a loop. */
	.s1 {
		--shift: -48px;
		background-image: url('/art/soe-como-x/strata-far.svg');
	}
	.s2 {
		--shift: -18px;
		background-image: url('/art/soe-como-x/strata-mid.svg');
	}
	.s3 {
		--shift: 14px;
		background-image: url('/art/soe-como-x/strata-near.svg');
	}
	@supports (animation-timeline: scroll()) {
		.stratum {
			animation: strata auto linear both;
			animation-timeline: scroll(root);
			animation-range: calc(100% - 900px) 100%;
		}
	}
	/* A shot at the surface: its wavefront goes down into the strata every 10 s. */
	.shot {
		left: 0;
		right: 0;
		bottom: 0;
		height: 150px;
		overflow: hidden;
	}
	.wave {
		--front: color-mix(in srgb, var(--text-2) 30%, transparent);
		top: -180px;
		left: calc(12% - 180px);
		width: 360px;
		height: 360px;
		border-radius: 50%;
		box-shadow: inset 0 0 0 1px var(--front);
		transform: scale(0.55);
		opacity: 0.6;
		animation: wave 10s var(--ease-out, ease-out) infinite;
	}
	.wave + .wave {
		transform: scale(0.85);
		opacity: 0.3;
		animation-delay: -5s;
	}

	/* Piano roll: semitone grid, the sung pitch, and the corrected notes. The box is a 1px strip
	   at the notes' bottom edge, so with the shared 120px root margin the snap starts once the
	   notes are on screen. */
	.roll {
		right: 24px;
		bottom: 12px;
		width: min(480px, 42%);
		height: 1px;
	}
	.roll::before,
	.roll::after,
	.roll svg {
		left: 0;
		bottom: 0;
		width: 100%;
		aspect-ratio: 480 / 140;
	}
	.roll::before,
	.roll::after {
		content: '';
		position: absolute;
	}
	.roll::before {
		background: var(--text-2);
		mask: url('/art/soe-como-x/pitch-grid.svg') 0 0 / 100% 100% no-repeat;
		opacity: 0.14;
	}
	.roll::after {
		background: var(--accent-hi);
		mask: url('/art/soe-como-x/pitch-curve.svg') 0 0 / 100% 100% no-repeat;
		opacity: 0.3;
	}
	.roll svg {
		overflow: visible;
	}
	rect {
		fill: var(--accent-hi);
		fill-opacity: 0.6;
		opacity: 0;
	}
	.roll:global([data-art-seen]) rect {
		animation: snap 0.55s var(--ease-mech, cubic-bezier(0.3, 1.4, 0.5, 1)) var(--d, 0s) both;
	}
	/* Each note starts where the voice was and snaps onto its line. */
	rect:nth-child(1) {
		--from: 6px;
		--d: 0.05s;
	}
	rect:nth-child(2) {
		--from: -5px;
		--d: 0.14s;
	}
	rect:nth-child(3) {
		--from: 4px;
		--d: 0.23s;
	}
	rect:nth-child(4) {
		--from: -6px;
		--d: 0.32s;
	}
	rect:nth-child(5) {
		--from: 5px;
		--d: 0.41s;
	}
	rect:nth-child(6) {
		--from: -5px;
		--d: 0.5s;
	}
	rect:nth-child(7) {
		--from: 5px;
		--d: 0.59s;
	}
	rect:nth-child(8) {
		--from: -4px;
		--d: 0.68s;
	}
	rect:nth-child(9) {
		--from: 6px;
		--d: 0.77s;
	}

	@keyframes wipe {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: none;
		}
	}
	@keyframes unwipe {
		from {
			transform: translateX(100%);
		}
		to {
			transform: none;
		}
	}
	@keyframes pen {
		0%,
		100% {
			opacity: 0;
		}
		6%,
		88% {
			opacity: 1;
		}
	}
	@keyframes strata {
		from {
			transform: translateY(var(--shift));
		}
		to {
			transform: none;
		}
	}
	@keyframes wave {
		from {
			transform: scale(0.04);
			opacity: 0.9;
		}
		to {
			transform: scale(1);
			opacity: 0;
		}
	}
	@keyframes snap {
		from {
			opacity: 0;
			transform: translateY(var(--from));
		}
		50% {
			opacity: 1;
		}
		to {
			opacity: 1;
			transform: none;
		}
	}

	/* Mobile: no gutters for the logs, no room for the wavefront beside the text. The notes
	   fit in the section gap under the last paragraph. */
	@media (max-width: 720px) {
		.geo,
		.log,
		.shot {
			display: none;
		}
		.hero {
			top: 96px;
			height: 80px;
		}
		.trace {
			mask-position: 16px 0;
			mask-size: calc(100% - 32px) 100%;
		}
		.strata {
			inset: 140px 0 0;
		}
		.roll {
			right: 16px;
			bottom: 4px;
			width: 52%;
		}
	}

	/* Off screen or with the tab hidden, every loop holds still. The strata follow the scroll
	   and cost nothing while it is idle, so they keep tracking it. !important: every
	   `animation` shorthand resets the play state to running, and the reveal rules are more
	   specific than this one. */
	:global([data-art='paused']) *:not(.stratum),
	:global([data-art='paused']) *::after {
		animation-play-state: paused !important;
	}
	/* Final frame: the whole trace, the strata at rest, the notes on their lines, two still
	   wavefront rings. */
	@media (prefers-reduced-motion: reduce) {
		.art-layer *,
		.art-layer *::before,
		.art-layer *::after {
			animation: none !important;
		}
		.win,
		.trace {
			transform: none;
		}
		rect {
			opacity: 1;
		}
	}
</style>
