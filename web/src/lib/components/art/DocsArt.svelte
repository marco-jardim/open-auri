<!--
	Docs art (FUX.ART, homage to Harry Nyquist), drawn on the paper under the text:
	- graph-paper margins, only in the page margins;
	- a Nyquist diagram (a stable loop: the curve passes outside the critical point -1) that
	  traces itself once when it enters the viewport;
	- discrete samples over a sine (six per period, above the Nyquist rate) that drop onto the
	  curve once when they enter;
	- the sinc function and a strip of five-hole telegraph tape, both drifting very slowly.
	Paper tones only (--paper-ink, --paper-muted, the page accent) at low opacity: line art behind
	text stays at or under 13 % and the margins at 7 %, so every text pair keeps 4.5:1. The
	existing ticker tape of the page is untouched (it keeps its own pause).
-->
<script lang="ts">
	import { artVisibility } from './visibility.ts';
</script>

<div class="art-layer" aria-hidden="true" {@attach artVisibility}>
	<div class="graph graph--left"></div>
	<div class="graph graph--right"></div>
	<div class="nyquist" {@attach artVisibility}>
		<svg viewBox="0 0 440 460" fill="none">
			<path class="axes" d="M10 230h420M100 10v440" />
			<circle class="unit" cx="100" cy="230" r="60" />
			<path
				class="echo"
				d="M400 230C400 188 381 137 359 104C336 71 296 47 265 33C233 20 197 20 169 23C142 26 121 33 100 50C79 67 51 105 41 127C31 148 36 167 38 181C39 196 46 204 50 211C54 218 60 222 63 225C66 228 67 228 70 230C73 231 77 234 81 234C85 235 91 235 94 234C98 233 99 231 100 230"
			/>
			<path
				class="trace-in"
				pathLength="1"
				d="M400 230C400 272 381 323 359 356C336 389 296 413 265 427C233 440 197 440 169 437C142 434 121 427 100 410C79 393 51 355 41 333C31 312 36 293 38 279C39 264 46 256 50 249C54 242 60 238 63 235C66 232 67 232 70 230C73 229 77 226 81 226C85 225 91 225 94 226C98 227 99 229 100 230"
			/>
			<circle class="critical" cx="40" cy="230" r="4" />
		</svg>
	</div>
	<div class="samples" {@attach artVisibility}>
		<i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i>
	</div>
	<div class="sinc" {@attach artVisibility}><span></span></div>
	<div class="punch" {@attach artVisibility}><span></span></div>
</div>

<style>
	.art-layer {
		/* Page margin outside the document grid (max-width 1440 px, 36 px or 27 px padding). */
		--margin: max(27px, calc(50% - 684px));
		position: absolute;
		inset: 0;
		z-index: -1;
		overflow: hidden;
		pointer-events: none;
		contain: layout paint;
	}

	.art-layer > * {
		position: absolute;
	}

	/* Graph paper in the margins only, fading toward the text. */
	.graph {
		top: 0;
		bottom: 0;
		width: var(--margin);
		background: var(--paper-muted, #6b5e4c);
		opacity: 0.07;
		mask:
			url('/art/docs/graph.svg') 0 0 / 40px 40px repeat,
			linear-gradient(90deg, #000 45%, transparent);
		mask-composite: intersect;
	}

	.graph--left {
		left: 0;
	}

	.graph--right {
		right: 0;
		transform: scaleX(-1);
	}

	.nyquist {
		top: 1040px;
		right: calc(var(--margin) + 24px);
		width: 340px;
		aspect-ratio: 440 / 460;
		color: var(--paper-ink, #29251f);
		opacity: 0.11;
	}

	.nyquist svg {
		display: block;
		width: 100%;
		height: 100%;
		stroke: currentColor;
		stroke-linecap: round;
	}

	.axes {
		stroke-width: 1;
	}

	.unit {
		stroke-width: 1;
		stroke-dasharray: 2 6;
	}

	.echo {
		stroke-width: 1.4;
		stroke-dasharray: 3 6;
	}

	.trace-in {
		stroke-width: 2.4;
	}

	.critical {
		fill: var(--accent, #8c2f2f);
		stroke: none;
	}

	/* Six samples per period of the sine: one per column, stem from the axis, dot on the curve. */
	.samples {
		top: 2300px;
		left: calc(var(--margin) + 266px);
		display: grid;
		grid-template-columns: repeat(12, 1fr);
		grid-template-rows: 100%;
		width: 360px;
		aspect-ratio: 360 / 160;
		opacity: 0.13;
	}

	.samples::before {
		content: '';
		position: absolute;
		inset: 0;
		background: var(--paper-ink, #29251f);
		mask: url('/art/docs/sine.svg') center / 100% 100% no-repeat;
	}

	.samples i {
		position: relative;
	}

	.samples i::before,
	.samples i::after {
		content: '';
		position: absolute;
		left: 50%;
	}

	.samples i::before {
		top: 31.25%;
		bottom: 50%;
		width: 1px;
		margin-left: -0.5px;
		background: var(--paper-muted, #6b5e4c);
		transform-origin: 50% 100%;
	}

	.samples i::after {
		top: calc(31.25% - 3.5px);
		width: 7px;
		height: 7px;
		margin-left: -3.5px;
		border-radius: 50%;
		background: var(--accent, #8c2f2f);
	}

	.samples i:nth-child(6n + 2)::before {
		top: 12.5%;
	}

	.samples i:nth-child(6n + 2)::after {
		top: calc(12.5% - 3.5px);
	}

	.samples i:nth-child(6n + 4)::before,
	.samples i:nth-child(6n + 5)::before,
	.samples i:nth-child(6n)::before {
		top: 50%;
		bottom: 31.25%;
		transform-origin: 50% 0;
	}

	.samples i:nth-child(6n + 5)::before {
		bottom: 12.5%;
	}

	.samples i:nth-child(6n + 4)::after,
	.samples i:nth-child(6n)::after {
		top: calc(68.75% - 3.5px);
	}

	.samples i:nth-child(6n + 5)::after {
		top: calc(87.5% - 3.5px);
	}

	.sinc {
		top: 46%;
		right: calc(var(--margin) + 40px);
		width: 520px;
		aspect-ratio: 3 / 1;
		opacity: 0.1;
	}

	.punch {
		top: 71%;
		left: calc(var(--margin) + 300px);
		width: 560px;
		height: 40px;
		opacity: 0.1;
	}

	.sinc span,
	.punch span {
		position: absolute;
		inset: 0;
	}

	.sinc span {
		background: var(--paper-ink, #29251f);
		mask: url('/art/docs/sinc.svg') center / 100% 100% no-repeat;
	}

	.punch span {
		background: var(--paper-ink, #29251f);
		mask: url('/art/docs/punch.svg') 0 0 / 240px 40px repeat-x;
		transform: rotate(-5deg);
	}

	@media (max-width: 650px) {
		.graph {
			width: 18px;
		}

		.nyquist {
			top: 860px;
			right: 21px;
			width: 220px;
		}

		.samples {
			top: 1900px;
			left: 21px;
			width: min(300px, calc(100% - 42px));
		}

		.sinc,
		.punch {
			display: none;
		}
	}

	@media (prefers-reduced-motion: no-preference) {
		/* The Nyquist branch waits undrawn, then traces itself once; its mirror and the critical
		   point appear after it. */
		.trace-in {
			stroke-dasharray: 1 1;
			stroke-dashoffset: 1;
		}

		.echo,
		.critical {
			opacity: 0;
		}

		.nyquist:global([data-art-seen]) > svg .trace-in {
			animation: trace 2.8s var(--ease-in-out, ease-in-out) 0.2s both;
		}

		.nyquist:global([data-art-seen]) > svg .critical {
			animation: appear 0.6s var(--ease-out, ease-out) 1.7s both;
		}

		.nyquist:global([data-art-seen]) > svg .echo {
			animation: appear 1.4s var(--ease-out, ease-out) 2.7s both;
		}

		/* Samples drop onto the sine one after another, once; the stems grow from the axis. */
		.samples i::before {
			transform: scaleY(0);
		}

		.samples i::after {
			opacity: 0;
		}

		.samples:global([data-art-seen]) > i::before {
			animation: stem 0.5s var(--ease-out, ease-out) calc(var(--d, 0s) + 0.42s) both;
		}

		.samples:global([data-art-seen]) > i::after {
			animation: drop 0.7s cubic-bezier(0.5, 0, 0.75, 0.4) var(--d, 0s) both;
		}

		.samples i:nth-child(2) {
			--d: 0.09s;
		}
		.samples i:nth-child(3) {
			--d: 0.18s;
		}
		.samples i:nth-child(4) {
			--d: 0.27s;
		}
		.samples i:nth-child(5) {
			--d: 0.36s;
		}
		.samples i:nth-child(6) {
			--d: 0.45s;
		}
		.samples i:nth-child(7) {
			--d: 0.54s;
		}
		.samples i:nth-child(8) {
			--d: 0.63s;
		}
		.samples i:nth-child(9) {
			--d: 0.72s;
		}
		.samples i:nth-child(10) {
			--d: 0.81s;
		}
		.samples i:nth-child(11) {
			--d: 0.9s;
		}
		.samples i:nth-child(12) {
			--d: 0.99s;
		}

		.sinc span {
			animation: float 26s var(--ease-in-out, ease-in-out) infinite alternate;
		}

		.punch span {
			animation: feed 32s var(--ease-in-out, ease-in-out) infinite alternate;
		}
	}

	@keyframes trace {
		from {
			stroke-dashoffset: 1;
		}
		to {
			stroke-dashoffset: 0;
		}
	}

	@keyframes appear {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	@keyframes drop {
		0% {
			transform: translateY(-34px);
			opacity: 0;
		}
		70% {
			transform: translateY(2px);
			opacity: 1;
		}
		100% {
			transform: none;
			opacity: 1;
		}
	}

	@keyframes stem {
		from {
			transform: scaleY(0);
		}
		to {
			transform: none;
		}
	}

	@keyframes float {
		from {
			transform: translateY(0) rotate(0deg);
		}
		to {
			transform: translateY(70px) rotate(2deg);
		}
	}

	@keyframes feed {
		from {
			transform: translateX(0) rotate(-5deg);
		}
		to {
			transform: translateX(48px) rotate(-3.5deg);
		}
	}

	:global([data-art='paused']) *,
	:global([data-art='paused']) *::before,
	:global([data-art='paused']) *::after {
		animation-play-state: paused !important;
	}

	/* Reduced motion: no animation; the diagram is drawn and every sample sits on the curve. */
	@media (prefers-reduced-motion: reduce) {
		.art-layer *,
		.art-layer *::before,
		.art-layer *::after {
			animation: none !important;
			transition: none !important;
		}
	}

	@media print {
		.art-layer {
			display: none;
		}
	}
</style>
