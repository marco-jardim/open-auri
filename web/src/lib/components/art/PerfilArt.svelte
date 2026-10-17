<!--
	Public profile art (FUX.ART, homage to Chris Lord-Alge): a signed record collection.
	- A large record in the hero corner: static grooves, with a light sheen turning over them.
	- A signature flourish (no letters, nobody's real signature) that writes itself once.
	- A wall of record sleeves at the foot, beside the homage note.
	Grooves and sleeves are static SVGs in /art/perfil used as masks, in page tokens. The
	ProfileRecord disc that turns 1/8 on hover is a real control and stays as it is.
-->
<script lang="ts">
	import { artVisibility } from './visibility.ts';
</script>

<div class="art-layer" aria-hidden="true" {@attach artVisibility}>
	<div class="record" {@attach artVisibility}>
		<span class="grooves"></span>
		<span class="sheen"></span>
	</div>
	<svg class="flourish" viewBox="0 0 520 160" fill="none">
		<path
			class="ink"
			pathLength="1"
			d="M10 120C60 118 92 60 120 40S170 10 160 46S100 140 140 136S230 60 262 44S300 40 290 72S250 128 292 122S388 74 430 70S500 86 512 60"
		/>
		<path class="ink ink--under" pathLength="1" d="M60 146C160 136 300 140 470 128" />
	</svg>
	<div class="sleeves"></div>
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

	.art-layer > * {
		position: absolute;
	}

	/* Mostly off the top right corner, clear of the hero copy on the left. */
	.record {
		--disc: clamp(300px, 44vw, 620px);
		top: calc(var(--disc) * -0.2);
		right: calc(var(--disc) * -0.3);
		width: var(--disc);
		aspect-ratio: 1;
	}

	.record span {
		position: absolute;
		inset: 0;
		mask: url('/art/perfil/grooves.svg') center / contain no-repeat;
	}

	.grooves {
		background: var(--text, #ece7dd);
		opacity: 0.07;
	}

	/* Two opposite highlights, as a lamp catches a spinning record. The grooves are concentric,
	   so turning the masked sheen keeps the grooves still and moves only the light. */
	.sheen {
		--shine: color-mix(in srgb, var(--accent, #d9a441) 70%, var(--text, #ece7dd));
		background: conic-gradient(
			from 20deg,
			transparent 0deg,
			var(--shine) 22deg,
			transparent 48deg 180deg,
			var(--shine) 202deg,
			transparent 228deg
		);
		opacity: 0.14;
	}

	.flourish {
		top: calc(var(--space-7, 48px) + 8px);
		right: 4%;
		width: min(44%, 520px);
		aspect-ratio: 520 / 160;
		color: var(--accent, #d9a441);
		opacity: 0.22;
	}

	.ink {
		stroke: currentColor;
		stroke-width: 2.2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.ink--under {
		stroke-width: 1.4;
	}

	.sleeves {
		right: 0;
		bottom: 0;
		width: min(46%, 660px);
		height: 230px;
		background: var(--text, #ece7dd);
		opacity: 0.05;
		mask:
			url('/art/perfil/records.svg') 0 100% / 220px 110px repeat,
			linear-gradient(90deg, transparent, #000 40%);
		mask-composite: intersect;
	}

	/* Narrow screens: the hero copy spans the width, so the record and the flourish fade back and
	   the sheen (the brightest part) goes; the sleeve wall needs a free side and goes too. */
	@media (max-width: 900px) {
		.sleeves {
			display: none;
		}

		.flourish {
			width: 70%;
			opacity: 0.1;
		}
	}

	@media (max-width: 640px) {
		.grooves {
			opacity: 0.04;
		}

		.sheen {
			display: none;
		}
	}

	@media (prefers-reduced-motion: no-preference) {
		.sheen {
			animation: spin 26s linear infinite;
		}

		/* The flourish waits unwritten, then writes itself once, the underline last. */
		.ink {
			stroke-dasharray: 1 1;
			stroke-dashoffset: 1;
		}

		.art-layer:global([data-art-seen]) > .flourish .ink {
			animation: write 2.6s var(--ease-in-out, ease-in-out) 0.3s both;
		}

		.art-layer:global([data-art-seen]) > .flourish .ink--under {
			animation-duration: 0.9s;
			animation-delay: 2.7s;
		}
	}

	@keyframes spin {
		to {
			transform: rotate(1turn);
		}
	}

	@keyframes write {
		from {
			stroke-dashoffset: 1;
		}
		to {
			stroke-dashoffset: 0;
		}
	}

	:global([data-art='paused']) *,
	:global([data-art='paused']) *::before,
	:global([data-art='paused']) *::after {
		animation-play-state: paused !important;
	}

	/* Reduced motion: the flourish is written, the light rests on the record. */
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
