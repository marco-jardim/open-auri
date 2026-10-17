<!--
	Offline and error art (FUX.ART): a cut tape carrying a signal trace. Every few seconds the
	loose end falters, then slides back and splices, and the trace runs whole for a moment before
	the cut opens again. CSS and one static SVG only (`/art/signal/trace.svg`, used as a mask), so
	the static /offline route adds no script beyond the visibility attachment. It sits in the top
	padding of the page, above every line of text.
-->
<script lang="ts">
	import { artVisibility } from './visibility.ts';
</script>

<div class="art-layer" aria-hidden="true" {@attach artVisibility}>
	<div class="cut">
		<span class="piece piece--held"></span>
		<span class="piece piece--loose"></span>
		<span class="splice"></span>
	</div>
</div>

<style>
	.art-layer {
		position: absolute;
		inset: 0;
		z-index: -1;
		overflow: hidden;
		pointer-events: none;
		contain: layout paint;
	}

	/* 9:1 like the drawing, never taller than 80 % of the top padding. */
	.cut {
		position: absolute;
		top: calc(var(--section-gap, 48px) * 0.08);
		left: var(--gutter, 24px);
		width: min(calc(100% - 2 * var(--gutter, 24px)), calc(var(--section-gap, 48px) * 7.2));
		aspect-ratio: 9 / 1;
	}

	.piece {
		position: absolute;
		inset: 0;
		background: color-mix(in srgb, var(--text, #ece7dd) 18%, transparent);
		mask: url('/art/signal/trace.svg') center / 100% 100% no-repeat;
	}

	/* The drawing's cut runs from x 324 to 396 of 720: each end keeps its own side. */
	.piece--held {
		clip-path: inset(0 46.7% 0 0);
	}

	.piece--loose {
		clip-path: inset(0 0 0 53.3%);
	}

	.splice {
		position: absolute;
		top: 0;
		bottom: 0;
		left: calc(45.8% - 24px);
		width: 48px;
		background: radial-gradient(
			closest-side,
			color-mix(in srgb, var(--accent, #ece7dd) 55%, transparent),
			transparent
		);
		opacity: 0;
	}

	@media (prefers-reduced-motion: no-preference) {
		.piece--held {
			animation: waver 10s linear infinite;
		}

		.piece--loose {
			animation: falter 10s linear infinite;
		}

		.splice {
			animation: mend 10s var(--ease-out, ease-out) infinite;
		}
	}

	/* The loose end stutters, then closes the 60-unit gap (60 / 720) and splices, then lets go. */
	@keyframes falter {
		0%,
		34% {
			transform: none;
			opacity: 1;
		}
		36% {
			transform: translateX(0.6%);
			opacity: 0.35;
		}
		38% {
			transform: translateX(-0.4%);
			opacity: 1;
		}
		40% {
			transform: translateX(0.9%);
			opacity: 0.2;
		}
		42% {
			transform: translateX(0.2%);
			opacity: 0.85;
		}
		44% {
			transform: translateX(0.5%);
			opacity: 0.3;
		}
		47% {
			transform: none;
			opacity: 1;
		}
		60%,
		84% {
			transform: translateX(-8.333%);
			opacity: 1;
		}
		100% {
			transform: none;
			opacity: 1;
		}
	}

	@keyframes waver {
		0%,
		35% {
			opacity: 1;
		}
		39% {
			opacity: 0.55;
		}
		41% {
			opacity: 1;
		}
		45% {
			opacity: 0.7;
		}
		48%,
		100% {
			opacity: 1;
		}
	}

	@keyframes mend {
		0%,
		58% {
			opacity: 0;
			transform: scale(0.6);
		}
		62% {
			opacity: 1;
			transform: scale(1);
		}
		76%,
		100% {
			opacity: 0;
			transform: scale(1.3);
		}
	}

	:global([data-art='paused']) *,
	:global([data-art='paused']) *::before,
	:global([data-art='paused']) *::after {
		animation-play-state: paused !important;
	}

	/* Reduced motion: no animation at all; the open cut is the final frame. */
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
