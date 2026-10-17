<!--
	Biblioteca art (FUX.ART, homage to Geoff Emerick): the archive room of a studio.
	- Control-room window: transom and double-glazing glints over the room's window, a light shaft
	  drifting across it and dust in the light (masked away from the centred hero copy).
	- Magnetic tape weaving down both sides, in and out behind the panels, ending on slowly
	  turning reels at the foot of the room.
	- A shelf of tape boxes with typed labels at the foot; on entering the viewport one more box
	  slides into its place, once. On very wide screens, box shelves fill the side walls.
	Shapes are static SVGs in /art/biblioteca used as masks, coloured with page tokens. Nothing
	here reads a level: reels turn at a constant rate.
-->
<script lang="ts">
	import { artVisibility } from './visibility.ts';
</script>

<div class="art-layer" aria-hidden="true" {@attach artVisibility}>
	<div class="glass" {@attach artVisibility}><div class="motes"></div></div>
	<div class="stack stack--left"></div>
	<div class="stack stack--right"></div>
	<div class="ribbon ribbon--left"></div>
	<div class="ribbon ribbon--right"></div>
	<div class="ledge" {@attach artVisibility}>
		<div class="spool spool--left"></div>
		<div class="spool spool--right"></div>
		<div class="shelf"></div>
		<div class="slide"></div>
	</div>
</div>

<style>
	.art-layer {
		/* Left edge of the archive panels (max-width 1500 px inside 28 px of padding). */
		--panel-edge: max(28px, calc(50% - 750px));
		--brass: var(--accent, #d9a441);
		position: absolute;
		inset: 0;
		z-index: -1;
		overflow: hidden;
		pointer-events: none;
		contain: layout paint;
	}

	.art-layer > *,
	.ledge > * {
		position: absolute;
	}

	/* Over the room's window (top 10 px, 12 % in from each side, 265 px tall, 13 px frame). */
	.glass {
		top: 23px;
		left: calc(12% + 13px);
		right: calc(12% + 13px);
		height: 239px;
		overflow: hidden;
		background:
			linear-gradient(
				180deg,
				transparent 36%,
				color-mix(in srgb, var(--ink, #0f0f0e) 55%, transparent) 36% 38.5%,
				color-mix(in srgb, var(--accent-hi, #e3bb70) 7%, transparent) 38.5% 39%,
				transparent 39%
			),
			repeating-linear-gradient(
				90deg,
				transparent 0 calc(25% - 5px),
				color-mix(in srgb, var(--accent-hi, #e3bb70) 6%, transparent) calc(25% - 5px)
					calc(25% - 4px),
				transparent calc(25% - 4px) 25%
			);
	}

	.glass::before {
		content: '';
		position: absolute;
		inset: 0 -20%;
		background: linear-gradient(
			115deg,
			transparent 22%,
			color-mix(in srgb, var(--accent-hi, #e3bb70) 9%, transparent) 42%,
			transparent 60%
		);
	}

	/* Dust in the light: only near the window's sides, never behind the centred hero copy. */
	.motes {
		--mote: color-mix(in srgb, var(--accent-hi, #e3bb70) 70%, transparent);
		position: absolute;
		inset: 0;
		mask: linear-gradient(90deg, #000 0 20%, transparent 30% 70%, #000 80%);
		background:
			radial-gradient(circle at 6% 22%, var(--mote) 0 1.2px, transparent 2px),
			radial-gradient(circle at 13% 64%, var(--mote) 0 1px, transparent 1.8px),
			radial-gradient(circle at 19% 38%, var(--mote) 0 1.4px, transparent 2.2px),
			radial-gradient(circle at 24% 82%, var(--mote) 0 1px, transparent 1.8px),
			radial-gradient(circle at 76% 30%, var(--mote) 0 1.3px, transparent 2.1px),
			radial-gradient(circle at 83% 72%, var(--mote) 0 1px, transparent 1.8px),
			radial-gradient(circle at 89% 46%, var(--mote) 0 1.5px, transparent 2.3px),
			radial-gradient(circle at 95% 16%, var(--mote) 0 1px, transparent 1.8px);
		opacity: 0.8;
	}

	.motes::after {
		content: '';
		position: absolute;
		inset: 0;
		background:
			radial-gradient(circle at 10% 48%, var(--mote) 0 1px, transparent 1.8px),
			radial-gradient(circle at 17% 14%, var(--mote) 0 1.2px, transparent 2px),
			radial-gradient(circle at 22% 58%, var(--mote) 0 0.9px, transparent 1.6px),
			radial-gradient(circle at 79% 54%, var(--mote) 0 1.1px, transparent 1.9px),
			radial-gradient(circle at 86% 20%, var(--mote) 0 0.9px, transparent 1.6px),
			radial-gradient(circle at 92% 78%, var(--mote) 0 1.2px, transparent 2px);
		opacity: 0.7;
	}

	/* Box shelves on the side walls, only where the walls are wide enough. */
	.stack {
		display: none;
		top: 300px;
		bottom: 240px;
		width: calc(50% - 790px);
		background: color-mix(in srgb, var(--brass) 14%, transparent);
		mask: url('/art/biblioteca/shelf.svg') 0 0 / 320px 120px repeat;
	}

	.stack--left {
		left: 0;
		mask-position: right top;
	}

	.stack--right {
		right: 0;
	}

	/* Tape weaving down each side: its crests pass behind the panels and come back out. */
	.ribbon {
		top: 290px;
		bottom: 111px;
		width: 48px;
		background: color-mix(in srgb, var(--brass) 30%, var(--ink, #0f0f0e));
		mask: url('/art/biblioteca/ribbon.svg') 0 0 / 48px 400px repeat-y;
		opacity: 0.9;
	}

	.ribbon--left {
		left: calc(var(--panel-edge) - 34px);
	}

	.ribbon--right {
		right: calc(var(--panel-edge) - 34px);
		transform: scaleX(-1);
	}

	.ledge {
		left: 0;
		right: 0;
		bottom: 0;
		height: 230px;
	}

	/* Plank under the box that slides in, continuing the shelf's own plank (y 108 to 113). */
	.ledge::after {
		content: '';
		position: absolute;
		left: 50%;
		bottom: 7px;
		width: 60px;
		height: 5px;
		margin-left: 290px;
		background: color-mix(in srgb, var(--brass) 18%, transparent);
	}

	/* Reels at the tape ends, centred under each ribbon. */
	.spool {
		bottom: 26px;
		width: 170px;
		aspect-ratio: 1;
		background: color-mix(in srgb, var(--brass) 24%, transparent);
		mask: url('/art/biblioteca/reel.svg') center / contain no-repeat;
	}

	.spool--left {
		left: calc(var(--panel-edge) - 95px);
	}

	.spool--right {
		right: calc(var(--panel-edge) - 95px);
	}

	.shelf {
		left: 50%;
		bottom: 0;
		width: 640px;
		height: 120px;
		margin-left: -350px;
		background: color-mix(in srgb, var(--brass) 18%, transparent);
		mask: url('/art/biblioteca/shelf.svg') 0 0 / 320px 120px repeat-x;
	}

	.slide {
		left: 50%;
		bottom: 12px;
		width: 30px;
		height: 100px;
		margin-left: 294px;
		background: color-mix(in srgb, var(--brass) 22%, transparent);
		mask: url('/art/biblioteca/box.svg') center / 100% 100% no-repeat;
	}

	@media (min-width: 1760px) {
		.stack {
			display: block;
		}
	}

	/* Narrow screens: the window is drawn by the hero itself and the side margins are thin, so
	   only the foot of the room stays: a short shelf, its sliding box and two small reels. */
	@media (max-width: 780px) {
		.glass,
		.ribbon {
			display: none;
		}

		.spool {
			bottom: 18px;
			width: 96px;
		}

		.spool--left {
			left: -34px;
		}

		.spool--right {
			right: -34px;
		}

		.shelf {
			width: 320px;
			margin-left: -175px;
		}

		.slide {
			margin-left: 149px;
		}

		.ledge::after {
			margin-left: 145px;
		}
	}

	@media (prefers-reduced-motion: no-preference) {
		.glass::before {
			animation: shaft 18s var(--ease-in-out, ease-in-out) infinite alternate;
		}

		.motes {
			animation: drift 14s var(--ease-in-out, ease-in-out) infinite alternate;
		}

		.motes::after {
			animation: drift-far 21s var(--ease-in-out, ease-in-out) infinite alternate-reverse;
		}

		.spool--left {
			animation: turn 44s linear infinite;
		}

		.spool--right {
			animation: turn 58s linear infinite reverse;
		}

		/* Before the foot of the room is seen, the last box waits off its place. */
		.slide {
			opacity: 0;
		}

		.ledge:global([data-art-seen]) > .slide {
			animation: slide-in 1.1s var(--ease-mech, cubic-bezier(0.3, 1.4, 0.5, 1)) 0.25s both;
		}
	}

	@keyframes shaft {
		from {
			transform: translateX(-12%);
			opacity: 0.6;
		}
		to {
			transform: translateX(14%);
			opacity: 1;
		}
	}

	@keyframes drift {
		from {
			transform: translate(0, 6px);
			opacity: 0.45;
		}
		to {
			transform: translate(10px, -14px);
			opacity: 0.95;
		}
	}

	@keyframes drift-far {
		from {
			transform: translate(-8px, 10px);
			opacity: 0.3;
		}
		to {
			transform: translate(6px, -10px);
			opacity: 0.85;
		}
	}

	@keyframes turn {
		to {
			transform: rotate(1turn);
		}
	}

	@keyframes slide-in {
		from {
			transform: translateX(96px);
			opacity: 0;
		}
		to {
			transform: none;
			opacity: 1;
		}
	}

	:global([data-art='paused']) *,
	:global([data-art='paused']) *::before,
	:global([data-art='paused']) *::after {
		animation-play-state: paused !important;
	}

	/* Reduced motion: nothing moves; every box sits on the shelf, the reels rest. */
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
