<!--
	Auth and account art (FUX.ART, homage to Rupert Neve): background line art of the console the
	real channel strip belongs to.
	- Ghost channel strips (input gain, dual-concentric EQ knobs, switches, fader) beside the strip.
	- An output transformer (laminated core, winding, flange, solder tags) with a slow warm glow.
	- Signal rules hugging the strip, with a glint running slowly down them.
	The real stage knobs and validation lamps live in AuthShell and follow real state; nothing
	here imitates them, lights on validation or reads a level. `variant="account"` fits the same
	motifs to the /conta column (header corner and the side gutters).
-->
<script lang="ts">
	import { artVisibility } from './visibility.ts';

	let { variant = 'shell' }: { variant?: 'shell' | 'account' } = $props();
</script>

<div class="art-layer art-{variant}" aria-hidden="true" {@attach artVisibility}>
	<div class="ghost ghost--left"></div>
	<div class="ghost ghost--right"></div>
	<div class="iron"><span class="glow"></span><span class="core"></span></div>
	<div class="rule rule--left"></div>
	<div class="rule rule--right"></div>
</div>

<style>
	.art-layer {
		--line: var(--strip-muted, var(--muted, #8f8a80));
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

	.ghost {
		width: 120px;
		background: var(--line);
		mask: url('/art/auth/channel.svg') top center / contain no-repeat;
	}

	.iron {
		aspect-ratio: 160 / 200;
	}

	.iron span {
		position: absolute;
	}

	.glow {
		inset: -40%;
		border-radius: 50%;
		background: radial-gradient(
			closest-side,
			color-mix(in srgb, var(--accent, #ece7dd) 45%, var(--warn, #e5a23a)),
			transparent
		);
		opacity: 0.16;
	}

	.core {
		inset: 0;
		background: var(--line);
		mask: url('/art/auth/transformer.svg') center / contain no-repeat;
	}

	.rule {
		width: 1px;
		overflow: hidden;
		background: linear-gradient(
			180deg,
			transparent,
			var(--strip-rule, var(--rule, rgba(236, 231, 221, 0.12))) 6% 94%,
			transparent
		);
	}

	/* The glint: hidden at rest (and under reduced motion), it runs down the rule. */
	.rule::after {
		content: '';
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 18%;
		background: linear-gradient(
			180deg,
			transparent,
			color-mix(in srgb, var(--accent, #ece7dd) 75%, transparent),
			transparent
		);
		opacity: 0;
	}

	/* ---- The auth pages: a 480 px strip centred 48 px below the bar. ---- */
	.art-shell .ghost {
		top: 48px;
		height: min(720px, calc(100% - 80px));
	}

	.art-shell .ghost--left {
		right: calc(50% + 300px);
		opacity: 0.14;
	}

	.art-shell .ghost--right {
		left: calc(50% + 300px);
		opacity: 0.08;
	}

	.art-shell .iron {
		top: 150px;
		left: calc(50% + 446px);
		width: 150px;
	}

	.art-shell .core {
		opacity: 0.26;
	}

	.art-shell .rule {
		top: 48px;
		bottom: 32px;
	}

	.art-shell .rule--left {
		left: calc(50% - 256px);
	}

	.art-shell .rule--right {
		left: calc(50% + 255px);
	}

	@media (max-width: 1200px) {
		.art-shell .ghost--right {
			display: none;
		}

		.art-shell .iron {
			left: auto;
			right: 24px;
		}
	}

	@media (max-width: 860px) {
		.art-shell .ghost,
		.art-shell .iron {
			display: none;
		}
	}

	@media (max-width: 560px) {
		.art-shell .rule {
			display: none;
		}
	}

	/* ---- /conta: the column of the account page. Text sits close, so the art stays fainter. ---- */
	.art-account .ghost--left {
		display: none;
	}

	.art-account .ghost--right {
		top: 20px;
		right: 28px;
		width: 84px;
		height: 504px;
		opacity: 0.06;
	}

	.art-account .iron {
		top: 36px;
		right: 128px;
		width: 110px;
	}

	.art-account .core {
		opacity: 0.1;
	}

	.art-account .glow {
		opacity: 0.1;
	}

	.art-account .rule {
		top: 24px;
		bottom: 24px;
	}

	.art-account .rule--left {
		left: 10px;
	}

	.art-account .rule--right {
		right: 10px;
	}

	@media (max-width: 640px) {
		.art-account .ghost,
		.art-account .iron {
			display: none;
		}

		.art-account .rule--left {
			left: 6px;
		}

		.art-account .rule--right {
			right: 6px;
		}
	}

	@media (prefers-reduced-motion: no-preference) {
		.glow {
			animation: warm 7s var(--ease-in-out, ease-in-out) infinite alternate;
		}

		.art-account .glow {
			animation-name: warm-faint;
		}

		.rule::after {
			opacity: 1;
			animation: signal 9s linear infinite;
		}

		.rule--right::after {
			animation-delay: -4.5s;
		}
	}

	@keyframes warm {
		from {
			opacity: 0.12;
			transform: scale(0.94);
		}
		to {
			opacity: 0.32;
			transform: scale(1.04);
		}
	}

	@keyframes warm-faint {
		from {
			opacity: 0.06;
			transform: scale(0.96);
		}
		to {
			opacity: 0.14;
			transform: scale(1.02);
		}
	}

	/* 18 % tall: from just above the rule to just below it (100 / 18 = 5.56 heights). */
	@keyframes signal {
		from {
			transform: translateY(-100%);
		}
		to {
			transform: translateY(560%);
		}
	}

	:global([data-art='paused']) *,
	:global([data-art='paused']) *::before,
	:global([data-art='paused']) *::after {
		animation-play-state: paused !important;
	}

	/* Reduced motion: no glow pulse, no glint; the line art stays. */
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
