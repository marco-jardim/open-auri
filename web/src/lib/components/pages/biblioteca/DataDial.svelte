<script lang="ts">
	import { number, type Locale } from './archive.ts';
	let {
		label,
		value,
		min,
		max,
		locale,
		unit = 'dB',
		digits = 1,
		signed = false,
		detail = ''
	}: {
		label: string;
		value: number | null;
		min: number;
		max: number;
		locale: Locale;
		/** Unit printed on the face and in the readout ('' for a ratio such as the correlator). */
		unit?: string;
		digits?: number;
		signed?: boolean;
		/** Secondary readout under the value (calculated figures only). */
		detail?: string;
	} = $props();
	const angle = $derived(
		value === null ? -50 : -50 + 100 * Math.max(0, Math.min(1, (value - min) / (max - min)))
	);
	const readout = $derived(
		`${signed && value !== null && value > 0 ? '+' : ''}${number(value, locale, digits)}${unit ? ` ${unit}` : ''}`
	);
</script>

<div class="dial">
	<div class="face" role="img" aria-label={`${label}: ${readout}${detail ? ` · ${detail}` : ''}`}>
		<svg viewBox="0 0 200 124" aria-hidden="true">
			<path d="M30 78 A90 90 0 0 1 170 78" fill="none" stroke="#51442e" />
			{#each [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as tick (tick)}
				<path d="M100 22v9" transform="rotate({-50 + tick * 10} 100 112)" stroke="#51442e" />
			{/each}
			<text x="28" y="96">{number(min, locale, 0)}</text><text x="165" y="96"
				>{signed && max > 0 ? '+' : ''}{number(max, locale, 0)}</text
			>
			{#if unit}<text x="100" y="77" text-anchor="middle">{unit}</text>{/if}
			{#if value !== null}
				<!-- Static needle at the calculated value: no sweep, no ballistics (it is not a meter of audio). -->
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
	<output>{readout}</output>
	{#if detail}<small class="detail">{detail}</small>{/if}
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
		font: 400 11px var(--face-data, 'JetBrains Mono', monospace);
	}
	.label {
		margin-top: 10px;
		color: #f0eedc;
		font: 400 var(--label-min, 11px) / 1.4 var(--face-data, 'JetBrains Mono', monospace);
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}
	output {
		display: block;
		margin-top: 5px;
		color: #ffe0a0;
		font: 500 var(--fs-readout, 14px) / 1.3 var(--face-data, 'JetBrains Mono', monospace);
		font-variant-numeric: tabular-nums slashed-zero;
	}
	.detail {
		display: block;
		margin-top: 2px;
		color: #e5e4cb;
		font: 400 var(--label-min, 11px) / 1.4 var(--face-data, 'JetBrains Mono', monospace);
		font-variant-numeric: tabular-nums slashed-zero;
	}
</style>
