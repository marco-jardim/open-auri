<!--
	Biblioteca dial. One face (scale, ticks, unit) for both modes: DADOS shows the calculated
	value, AO VIVO the real worklet reading on the same scale. Live ballistics come with the
	frames; nothing is eased here. Under reduced motion the needle and the readout both follow
	the reading at 10 Hz.
-->
<script lang="ts">
	import { prefersReducedMotion } from 'svelte/motion';
	import { Chip } from '#lib/components/primitives/index.ts';
	import { ThrottledNumber } from '#lib/components/meters/motion.svelte.ts';
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
		detail = '',
		live = null,
		liveUnit,
		reducedMotion
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
		/** Only real worklet readings; null keeps the calculated DATA dial. */
		live?: number | null;
		/** Unit of the live readout under the face (the face itself never changes). */
		liveUnit?: string;
		/** Overrides the `prefers-reduced-motion` media query. */
		reducedMotion?: boolean;
	} = $props();
	const TICKS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
	const isLive = $derived(typeof live === 'number' && Number.isFinite(live));
	const reduced = $derived(reducedMotion ?? prefersReducedMotion.current);
	const numeric = new ThrottledNumber();
	$effect(() => {
		// Never carry a calculated DATA value into the throttled live reading.
		numeric.push(isLive ? live : null);
	});
	$effect(() => () => numeric.destroy());
	/** Live reading at 10 Hz (the first live value shows at once). */
	const throttled = $derived(numeric.value ?? live);
	const shown = $derived(isLive ? throttled : value);
	// Full motion: the needle follows every frame. Reduced motion: it moves with the readout.
	const needle = $derived(isLive ? (reduced ? throttled : live) : value);
	const angle = $derived(
		needle === null ? -50 : -50 + 100 * Math.max(0, Math.min(1, (needle - min) / (max - min)))
	);
	const readoutUnit = $derived(isLive ? (liveUnit ?? unit) : unit);
	const readout = $derived(
		`${signed && shown !== null && shown > 0 ? '+' : ''}${number(shown, locale, digits)}${readoutUnit ? ` ${readoutUnit}` : ''}`
	);
</script>

<div class="dial" data-mode={isLive ? 'live' : 'data'}>
	<div
		class="face"
		role={shown === null ? 'img' : 'meter'}
		aria-label={`${label}: ${readout}${detail && !isLive ? ` · ${detail}` : ''}`}
		aria-valuemin={shown === null ? undefined : min}
		aria-valuemax={shown === null ? undefined : max}
		aria-valuenow={shown === null ? undefined : Math.max(min, Math.min(max, shown))}
		aria-valuetext={shown === null ? undefined : readout}
	>
		<svg viewBox="0 0 200 124" aria-hidden="true">
			<path d="M30 78 A90 90 0 0 1 170 78" fill="none" stroke="#51442e" />
			{#each TICKS as tick (tick)}
				<path d="M100 22v9" transform="rotate({-50 + tick * 10} 100 112)" stroke="#51442e" />
			{/each}
			<text x="28" y="96">{number(min, locale, 0)}</text><text x="165" y="96"
				>{signed && max > 0 ? '+' : ''}{number(max, locale, 0)}</text
			>
			{#if unit}<text x="100" y="77" text-anchor="middle">{unit}</text>{/if}
			{#if needle !== null}
				<!-- DATA: static at the calculated value. LIVE: placed at the worklet reading, no easing. -->
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
	<Chip mode={isLive ? 'live' : 'data'} />
	<output>{readout}</output>
	{#if detail}<small class="detail" class:live-detail={isLive}>{detail}</small>{/if}
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
	.needle {
		/* Ballistics come from the meter frames; a CSS transition would fake them. */
		transition: none;
	}
	.label {
		margin-top: 10px;
		color: #f0eedc;
		font: 400 var(--label-min, 11px) / 1.4 var(--face-data, 'JetBrains Mono', monospace);
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}
	.dial :global(.chip--mode) {
		margin-top: 5px;
		background: #252e22;
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
	.live-detail {
		/* Keeps the exact DATA detail height (including wrapped lines) while live. */
		visibility: hidden;
	}
</style>
