<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	let {
		revealed = false,
		moving = false,
		selected = -1,
		names = [],
		count = 3,
		disabled = true,
		onselect
	}: {
		revealed?: boolean;
		moving?: boolean;
		selected?: number;
		names?: string[];
		count?: number;
		disabled?: boolean;
		onselect: (index: number) => void;
	} = $props();
	const uid = $props.id();
</script>

<section class="room" class:revealed class:moving aria-label={m.cego_title()}>
	<svg
		viewBox="0 0 1600 600"
		preserveAspectRatio="xMidYMid slice"
		role="img"
		aria-label={m.cego_scene()}
	>
		<defs>
			<linearGradient id="{uid}-wall" x2="0" y2="1"
				><stop stop-color="#21190f" /><stop offset="1" stop-color="#080605" /></linearGradient
			>
			<pattern id="{uid}-slats" width="34" height="40" patternUnits="userSpaceOnUse"
				><rect width="26" height="40" fill="#201910" /><rect
					x="26"
					width="8"
					height="40"
					fill="#090706"
				/></pattern
			>
			<pattern id="{uid}-weave" width="5" height="5" patternUnits="userSpaceOnUse"
				><rect width="5" height="2" fill="#ded0ab" opacity=".035" /><rect
					width="2"
					height="5"
					fill="#000"
					opacity=".3"
				/></pattern
			>
			<linearGradient id="{uid}-pleat"
				><stop stop-color="#000" stop-opacity=".5" /><stop
					offset=".52"
					stop-color="#fff0d0"
					stop-opacity=".07"
				/><stop offset="1" stop-color="#000" stop-opacity=".5" /></linearGradient
			>
			<pattern id="{uid}-folds" width="96" height="428" patternUnits="userSpaceOnUse"
				><rect width="96" height="428" fill="url(#{uid}-pleat)" /></pattern
			>
			<linearGradient id="{uid}-light" x2="0" y2="1"
				><stop stop-color="#ffe2a6" stop-opacity=".2" /><stop
					offset="1"
					stop-color="#ffd27a"
					stop-opacity="0"
				/></linearGradient
			>
			<radialGradient id="{uid}-floor"
				><stop stop-color="#ffd27a" stop-opacity=".18" /><stop
					offset="1"
					stop-color="#ffd27a"
					stop-opacity="0"
				/></radialGradient
			>
		</defs>
		<rect width="1600" height="600" fill="#050404" />
		<rect y="40" width="1600" height="430" fill="url(#{uid}-wall)" />
		<rect y="40" width="1600" height="430" fill="url(#{uid}-slats)" opacity=".55" />
		<g stroke="#ffd27a" stroke-opacity=".17" fill="none">
			<path d="M470 362 L800 466 M800 362 V466 M1130 362 L800 466 M420 364 H1180" />
			<ellipse cx="800" cy="466" rx="78" ry="10" />
		</g>
		{#each [470, 800, 1130].slice(0, count) as x, index (x)}
			<g class="speaker" transform="translate({x} 362)">
				<rect
					x="-62"
					y="-262"
					width="124"
					height="262"
					rx="9"
					fill="#070707"
					stroke="#ffd27a"
					stroke-opacity=".45"
				/>
				<circle cy="-215" r="17" fill="#10100e" stroke="#343027" />
				<circle cy="-150" r="40" fill="#10100e" stroke="#343027" />
				<circle cy="-62" r="40" fill="#10100e" stroke="#343027" />
				{#if revealed}<text y="-280" text-anchor="middle" fill="#ffd27a" font-size="20"
						>{names[index] ?? ''}</text
					>{/if}
			</g>
		{/each}
		<g class="scrim">
			<rect y="40" width="1600" height="428" fill="#0b0a09" />
			<rect y="40" width="1600" height="428" fill="url(#{uid}-weave)" />
			<rect y="40" width="1600" height="428" fill="url(#{uid}-folds)" />
			<rect y="40" width="1600" height="428" fill="url(#{uid}-light)" opacity=".5" />
			<rect y="454" width="1600" height="14" fill="#050404" />
		</g>
		<rect y="30" width="1600" height="11" fill="#302921" />
		<path d="M754 0 H846 L838 22 H762 Z" fill="#28221b" />
		<ellipse cx="800" cy="24" rx="40" ry="9" fill="#ffe2a6" opacity=".7" />
		<rect y="468" width="1600" height="132" fill="#0c0907" />
		<ellipse cx="800" cy="550" rx="470" ry="70" fill="url(#{uid}-floor)" />
		<polygon points="768,26 832,26 1250,600 350,600" fill="url(#{uid}-light)" />
		<circle class="lock" cx="800" cy="478" r="4" fill={moving ? '#57401f' : '#ffd27a'} />
	</svg>
	<div class="room-title">
		<div class="eyebrow">{m.cego_eyebrow()}</div>
		<h1>{m.cego_heading()}</h1>
		<p>{m.cego_lede()}</p>
	</div>
	<div class="cue" aria-hidden="true">
		<span class="lamp" class:on={!moving}></span>
		<span>{moving ? m.cego_shuffling() : revealed ? m.cego_revealed() : m.cego_closed()}</span>
	</div>
	<div class="floor-positions">
		{#each Array.from({ length: count }).keys() as position (position)}
			<button
				type="button"
				aria-label={m.cego_position({ number: position + 1 })}
				aria-pressed={selected === position}
				disabled={disabled || moving}
				onclick={() => onselect(position)}
			>
				{position + 1}
			</button>
		{/each}
	</div>
</section>

<style>
	.room {
		position: relative;
		height: clamp(400px, 64vh, 660px);
		background: #070605;
		overflow: hidden;
		isolation: isolate;
	}
	svg {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
	}
	.room-title {
		position: absolute;
		left: clamp(16px, 4vw, 56px);
		top: clamp(18px, 5vh, 46px);
		max-width: 440px;
		pointer-events: none;
	}
	.eyebrow {
		font: 11px var(--mono, monospace);
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: #d3b780;
	}
	h1 {
		font: italic 400 clamp(40px, 5.4vw, 72px)/0.95 var(--serif, 'Instrument Serif', Georgia, serif);
		color: #f4ecdc;
		margin: 0.18em 0 0.22em;
		text-shadow: 0 2px 24px #000;
	}
	p {
		color: #bdb5a6;
		max-width: 380px;
		font-size: 14.5px;
		text-shadow: 0 1px 8px #000;
	}
	.cue {
		position: absolute;
		right: clamp(12px, 3vw, 40px);
		top: clamp(18px, 5vh, 46px);
		display: flex;
		gap: 12px;
		align-items: center;
		padding: 12px 16px;
		border: 1px solid #343027;
		border-radius: 8px;
		background: linear-gradient(#1b1916, #100f0d);
		font: 12px var(--mono, monospace);
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.lamp {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: #30281c;
	}
	.lamp.on {
		background: #ffd27a;
		box-shadow: 0 0 10px #ffd27a77;
	}
	.scrim {
		transition: transform 1.9s cubic-bezier(0.65, 0, 0.2, 1);
	}
	.revealed .scrim {
		transform: translateY(-430px);
	}
	.moving .speaker {
		animation: shuffle 3s ease-in-out;
	}
	@keyframes shuffle {
		50% {
			translate: 100px 0;
		}
	}
	.floor-positions {
		position: absolute;
		bottom: 5%;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		gap: 30px;
	}
	button {
		width: 100px;
		height: 50px;
		background: #ece7dd09;
		border: 1px dashed #ece7dd77;
		transform: skew(-8deg);
		color: #ece7dd;
		font: 26px var(--mono, monospace);
		cursor: pointer;
	}
	button[aria-pressed='true'] {
		background: #ffd27a25;
		border: 1px solid #ffd27a;
		color: #ffd27a;
	}
	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	button:focus-visible {
		outline: 2px solid #ffd27a;
		outline-offset: 4px;
	}
	@media (max-width: 760px) {
		.room {
			height: auto;
			aspect-ratio: 16/11;
			min-height: 250px;
		}
		h1 {
			font-size: 34px;
			max-width: 220px;
		}
		.room-title p {
			display: none;
		}
		.eyebrow {
			font-size: 9px;
			max-width: 200px;
		}
		.cue {
			top: auto;
			bottom: 28%;
			font-size: 10px;
			padding: 6px 8px;
		}
		button {
			width: 64px;
			height: 35px;
			font-size: 20px;
		}
		.floor-positions {
			gap: 20px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.scrim {
			transition: none;
		}
		.moving .speaker {
			animation: none;
		}
	}
</style>
