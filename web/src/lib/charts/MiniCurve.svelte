<script lang="ts">
	import { miniCurvePath, type Curve } from './response.ts';
	import { dbScale } from './scales.ts';

	interface Props {
		curve: Curve;
		label: string;
		description: string;
		minDb?: number;
		maxDb?: number;
		color?: string;
	}
	let {
		curve,
		label,
		description,
		minDb = -24,
		maxDb = 12,
		color = 'currentColor'
	}: Props = $props();
	const path = $derived(miniCurvePath(curve, 120, 32, minDb, maxDb));
	const zero = $derived(dbScale(minDb, maxDb, 31, 1)(0));
</script>

<svg viewBox="0 0 120 32" role="img" aria-label={label}>
	<title>{label}</title>
	<desc>{description}</desc>
	{#if minDb <= 0 && maxDb >= 0}
		<path d={`M1,${zero}H119`} stroke={color} opacity="0.35" fill="none" />
	{/if}
	<path d={path} stroke={color} stroke-width="1.5" fill="none" />
</svg>

<style>
	svg {
		display: block;
		width: 100%;
		height: auto;
	}
	path {
		vector-effect: non-scaling-stroke;
	}
</style>
