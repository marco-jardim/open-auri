<!--
	Comunidade art layer (FUX.ART.3; homage to Bob Clearmountain, the mix engineer of the Power
	Station desks and of Live Aid, 1985): the page sits on a large console surface. Line-art channel
	strips run down the whole page, a long strip of masking tape carries hand-written channel
	names, a patchbay with tape labels closes the page, and a studio ON AIR lamp hangs over the
	hero (decoration only: the real NO AR tally of the publishing desk is untouched).

	WOW: on the first entry the faders slide once to their rest positions and a lens flare sweeps
	past the lamp; afterwards the faders never move again and follow nothing, so they can never
	read as meters (plan §0.12.7). The only loop is the slow halo of the lamp.

	Contract: art/README.md. Heavy shapes are static masks in /art/comunidade/ coloured by tokens;
	the markup is static (no state, no effects), so the route only pays for the template and the
	shared `artVisibility` attachment. The page root (.oa-comunidade) already is
	`position: relative; isolation: isolate` (comunidade.css). Class names carry an `art-` prefix
	so no page selector or test locator can pick them up.
-->
<script lang="ts">
	import { artVisibility } from './visibility.ts';
</script>

<div class="art-layer" aria-hidden="true" data-art="paused" {@attach artVisibility}>
	<div class="art-surface"></div>
	<div class="art-strips">
		<span class="art-tape"></span>
		<span class="art-faders">
			<i style="--y:62px;--i:0"></i>
			<i style="--y:48px;--i:1"></i>
			<i style="--y:70px;--i:2"></i>
			<i style="--y:40px;--i:3"></i>
			<i style="--y:55px;--i:4"></i>
			<i style="--y:30px;--i:5"></i>
			<i style="--y:66px;--i:6"></i>
			<i style="--y:44px;--i:7"></i>
			<i style="--y:58px;--i:8"></i>
			<i style="--y:36px;--i:9"></i>
			<i style="--y:72px;--i:10"></i>
			<i style="--y:50px;--i:11"></i>
			<i style="--y:46px;--i:12"></i>
			<i style="--y:64px;--i:13"></i>
			<i style="--y:38px;--i:14"></i>
			<i style="--y:60px;--i:15"></i>
			<i style="--y:52px;--i:16"></i>
			<i style="--y:34px;--i:17"></i>
			<i style="--y:68px;--i:18"></i>
			<i style="--y:42px;--i:19"></i>
			<i style="--y:56px;--i:20"></i>
			<i style="--y:74px;--i:21"></i>
			<i style="--y:45px;--i:22"></i>
			<i style="--y:61px;--i:23"></i>
		</span>
	</div>
	<span class="art-onair"></span>
	<span class="art-flare"></span>
	<span class="art-loose art-loose-a"></span>
	<span class="art-loose art-loose-b"></span>
	<div class="art-patchbay"></div>
</div>

<style>
	.art-layer {
		position: absolute;
		inset: 0;
		z-index: -1;
		overflow: hidden;
		pointer-events: none;
		contain: strict;
	}

	/* The console surface: full channel strips, very faint, wherever the page background shows
	   (section gaps, gutters, the translucent tool drawers). */
	.art-surface {
		position: absolute;
		inset: 400px 0 200px;
		background: var(--text);
		mask-image: url('/art/comunidade/strips.svg');
		mask-size: 192px 360px;
		opacity: 0.035;
	}

	/* Hero strips: the fader section of the strips in the free top-right of the hero, faded
	   towards the title so the copy keeps its contrast. */
	.art-strips {
		position: absolute;
		top: -120px;
		left: 50%;
		right: 0;
		height: 360px;
		mask-image: linear-gradient(90deg, transparent, black 24%);
	}
	.art-strips::before {
		content: '';
		position: absolute;
		inset: 0;
		background: var(--text);
		mask-image: url('/art/comunidade/strips.svg');
		mask-size: 192px 360px;
		mask-repeat: repeat-x;
		opacity: 0.09;
	}
	/* Masking tape across the scribble row, one hand-written name per channel. */
	.art-tape {
		position: absolute;
		top: 199px;
		left: 0;
		right: 0;
		height: 22px;
		background: var(--paper);
		opacity: 0.12;
	}
	.art-tape::after,
	.art-loose::after {
		content: '';
		position: absolute;
		inset: 0;
		background: var(--marker-ink, var(--paper-ink));
		mask-image: url('/art/comunidade/scribbles.svg');
		mask-size: 192px 22px;
		mask-repeat: repeat-x;
	}
	/* Fader caps sit on the slots of the strips (64 px per channel, slot from 236 px). */
	.art-faders {
		position: absolute;
		top: 236px;
		left: 0;
		width: 1536px;
		height: 112px;
	}
	.art-faders i {
		position: absolute;
		top: 0;
		left: calc(var(--i, 0) * 64px + 21px);
		box-sizing: border-box;
		width: 22px;
		height: 12px;
		border: 1px solid color-mix(in srgb, var(--text) 24%, transparent);
		border-radius: var(--rad-xs);
		background: linear-gradient(
			transparent 4.5px,
			color-mix(in srgb, var(--text) 24%, transparent) 4.5px 5.5px,
			transparent 5.5px
		);
		transform: translateY(var(--y, 50px));
	}

	/* ON AIR lamp on the studio wall: a dim red lens with a soft halo, no lettering. */
	.art-onair {
		position: absolute;
		top: 14px;
		left: 62%;
		width: 104px;
		height: 34px;
		isolation: isolate;
		border: 1px solid color-mix(in srgb, var(--text) 16%, transparent);
		border-radius: var(--rad-lg);
		background: color-mix(in srgb, var(--ink-2) 80%, transparent);
		opacity: 0.6;
	}
	.art-onair::before {
		content: '';
		position: absolute;
		inset: 5px;
		border-radius: var(--rad-sm);
		background: radial-gradient(
			120% 140% at 50% 40%,
			color-mix(in srgb, var(--danger) 55%, transparent),
			color-mix(in srgb, var(--danger) 14%, transparent) 70%
		);
	}
	.art-onair::after {
		content: '';
		position: absolute;
		inset: -36px -56px;
		z-index: -1;
		border-radius: 50%;
		background: radial-gradient(
			closest-side,
			color-mix(in srgb, var(--danger) 30%, transparent),
			transparent
		);
		opacity: 0.55;
	}

	/* Studio lens flare at the lamp's height: an anamorphic streak and its ghosts. */
	.art-flare {
		position: absolute;
		top: -29px;
		left: 0;
		right: 0;
		height: 120px;
	}
	.art-flare::before,
	.art-flare::after {
		content: '';
		position: absolute;
		inset: 0;
		opacity: 0;
	}
	.art-flare::before {
		background:
			radial-gradient(
				50% 3% at 50% 50%,
				color-mix(in srgb, var(--text) 70%, transparent),
				transparent
			),
			radial-gradient(
				22% 34% at 50% 50%,
				color-mix(in srgb, var(--accent) 22%, transparent),
				transparent
			);
	}
	.art-flare::after {
		background:
			radial-gradient(
				circle at 34% 62%,
				color-mix(in srgb, var(--accent) 20%, transparent) 0 9px,
				transparent 10px
			),
			radial-gradient(
				circle at 44% 40%,
				color-mix(in srgb, var(--text) 14%, transparent) 0 4px,
				transparent 5px
			),
			radial-gradient(
				circle at 58% 70%,
				transparent 0 14px,
				color-mix(in srgb, var(--accent) 16%, transparent) 15px 17px,
				transparent 18px
			);
	}

	/* Loose pieces of tape stuck to the console further down the page. */
	.art-loose {
		position: absolute;
		width: 150px;
		height: 22px;
		background: var(--paper);
		clip-path: polygon(0 10%, 4% 0, 96% 6%, 100% 0, 98% 52%, 100% 100%, 3% 94%, 0 100%, 2% 48%);
		opacity: 0.1;
	}
	.art-loose-a {
		top: 38%;
		left: -28px;
		rotate: -5deg;
	}
	.art-loose-b {
		top: 71%;
		right: -30px;
		rotate: 4deg;
	}
	.art-loose-b::after {
		mask-position: -64px 0;
	}

	/* Patchbay with tape labels under the tool drawers. */
	.art-patchbay {
		position: absolute;
		inset: auto 0 0;
		height: 200px;
		mask-image: linear-gradient(transparent, black 55%);
	}
	.art-patchbay::before {
		content: '';
		position: absolute;
		inset: 0;
		background: var(--text);
		mask-image: url('/art/comunidade/patchbay.svg');
		mask-size: 96px 64px;
		opacity: 0.07;
	}

	/* Motion (fux-art-brief §2): one-shot entrances wait until the layer is seen in a visible tab;
	   everything holds still off-screen or with the tab hidden. Every var() in a shorthand has a
	   fallback, so a missing token never turns the animation off. */
	@media (prefers-reduced-motion: no-preference) {
		.art-faders i {
			animation: fader-in 1.2s var(--ease-mech, cubic-bezier(0.3, 1.4, 0.5, 1))
				calc(var(--i, 0) * 45ms + 250ms) both paused;
		}
		.art-flare::before {
			animation: flare-sweep 2.8s var(--ease-in-out, cubic-bezier(0.65, 0, 0.35, 1)) 0.5s both
				paused;
		}
		.art-flare::after {
			animation: flare-ghost 2.8s var(--ease-in-out, cubic-bezier(0.65, 0, 0.35, 1)) 0.5s both
				paused;
		}
		.art-layer:global([data-art='running'][data-art-seen]) .art-faders i,
		.art-layer:global([data-art='running'][data-art-seen]) .art-flare::before,
		.art-layer:global([data-art='running'][data-art-seen]) .art-flare::after {
			animation-play-state: running;
		}
		.art-onair::after {
			animation: onair-halo 7.2s var(--ease-in-out, cubic-bezier(0.65, 0, 0.35, 1)) infinite
				alternate;
		}
	}
	.art-layer:global([data-art='paused']) *,
	.art-layer:global([data-art='paused']) *::before,
	.art-layer:global([data-art='paused']) *::after {
		animation-play-state: paused !important;
	}
	@keyframes fader-in {
		from {
			transform: translateY(100px);
		}
	}
	@keyframes flare-sweep {
		0% {
			opacity: 0;
			transform: translateX(-45%);
		}
		40% {
			opacity: 1;
		}
		100% {
			opacity: 0;
			transform: translateX(30%);
		}
	}
	@keyframes flare-ghost {
		0% {
			opacity: 0;
			transform: translateX(25%);
		}
		40% {
			opacity: 1;
		}
		100% {
			opacity: 0;
			transform: translateX(-25%);
		}
	}
	@keyframes onair-halo {
		from {
			opacity: 0.3;
			transform: scale(0.92);
		}
		to {
			opacity: 0.75;
			transform: scale(1.06);
		}
	}

	/* Final frame: faders at rest, no flare, the halo steady. */
	@media (prefers-reduced-motion: reduce) {
		.art-layer,
		.art-layer *,
		.art-layer *::before,
		.art-layer *::after {
			animation: none !important;
			transition: none !important;
		}
	}

	/* Mobile: the strips and the surface only. */
	@media (max-width: 640px) {
		/* The single-column hero puts the copy over the strips: softer still. */
		.art-strips {
			left: 28%;
			opacity: 0.6;
		}
		.art-onair,
		.art-flare,
		.art-loose {
			display: none;
		}
	}
</style>
