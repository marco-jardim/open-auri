<script lang="ts">
	import { number, type Locale } from './archive.ts';
	let {
		label,
		value,
		min,
		max,
		locale
	}: {
		label: string;
		value: number | null;
		min: number;
		max: number;
		locale: Locale;
	} = $props();
	const angle = $derived(
		value === null ? -50 : -50 + 100 * Math.max(0, Math.min(1, (value - min) / (max - min)))
	);
</script>

<div class="dial">
	<div class="face" role="img" aria-label={`${label}: ${number(value, locale)} dB`}>
		<svg viewBox="0 0 200 124" aria-hidden="true">
			<path d="M30 78 A90 90 0 0 1 170 78" fill="none" stroke="#51442e" />
			{#each [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as tick (tick)}
				<path d="M100 22v9" transform="rotate({-50 + tick * 10} 100 112)" stroke="#51442e" />
			{/each}
			<text x="28" y="96">{number(min, locale, 0)}</text><text x="165" y="96"
				>{number(max, locale, 0)}</text
			>
			<text x="100" y="77" text-anchor="middle">dB</text>
			{#if value !== null}
				<path
					class="needle"
					d="M100 112V24"
					stroke="#452a1b"
					stroke-width="2"
					transform="rotate({angle} 100 112)"
				/>
			{/if}
			<circle cx="100" cy="112" r="4" fill="#403520" />
		</svg>
	</div>
	<div class="label">{label}</div>
	<output>{number(value, locale)} dB</output>
</div>

<style>
	.dial {
		min-width: 0;
		text-align: center;
	}
	.face {
		background: radial-gradient(ellipse at 25% 5%, #fff6ca, #e1cfa0 70%, #bdab7e);
		border: 8px solid #242720;
		border-radius: 14px 14px 7px 7px;
		box-shadow:
			0 2px #aeb29466,
			0 5px 9px #0007;
	}
	svg {
		display: block;
		width: 100%;
	}
	text {
		fill: #403520;
		font:
			10px 'JetBrains Mono',
			monospace;
	}
	.label {
		margin-top: 10px;
		color: #f0eedc;
		font:
			10px 'JetBrains Mono',
			monospace;
		text-transform: uppercase;
	}
	output {
		display: block;
		margin-top: 5px;
		color: #ffe0a0;
		font:
			14px 'JetBrains Mono',
			monospace;
	}
	@media (prefers-reduced-motion: reduce) {
		.needle {
			display: none;
		}
	}
</style>
