<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		label: string;
		description: string;
		width?: number;
		height?: number;
		theme?: 'scope' | 'paper' | 'cable';
		children: Snippet;
	}

	let {
		label,
		description,
		width = 820,
		height = 380,
		theme = 'scope',
		children
	}: Props = $props();
	let clientWidth = $state(0);
	const labelScale = $derived(width / (clientWidth || width));
</script>

<div
	class="chart"
	class:paper={theme === 'paper'}
	class:cable={theme === 'cable'}
	class:compact={clientWidth > 0 && clientWidth < 600}
	bind:clientWidth
	style={`--label-desktop:${11 * labelScale}px;--label-mobile:${10 * labelScale}px`}
>
	<svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
		<title>{label}</title>
		<desc>{description}</desc>
		{@render children()}
	</svg>
</div>

<style>
	.chart {
		--chart-surface: #101a16;
		--chart-ink: #ece8dd;
		--chart-muted: #acb8ae;
		--chart-grid: #405448;
		--chart-accent: #ff9e62;
		--chart-secondary: #b6edb0;
		width: 100%;
		min-width: 0;
		color: var(--chart-ink);
		background: var(--chart-surface);
		border: 1px solid var(--chart-grid);
		border-radius: 6px;
	}
	.paper {
		--chart-surface: #efe6d2;
		--chart-ink: #29251f;
		--chart-muted: #65523d;
		--chart-grid: #ad9c81;
		--chart-accent: #8c2f2f;
		--chart-secondary: #365c55;
		border-radius: 0;
	}
	.cable {
		--chart-surface: #111c1e;
		--chart-accent: #4fd1c5;
		--chart-secondary: #e9c27d;
	}
	svg {
		display: block;
		width: 100%;
		height: auto;
		overflow: hidden;
	}
	.chart :global(text) {
		fill: var(--chart-ink);
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: var(--label-desktop);
	}
	.chart :global(path),
	.chart :global(line),
	.chart :global(circle),
	.chart :global(rect) {
		vector-effect: non-scaling-stroke;
	}
	.compact :global(.chart-alt) {
		display: none;
	}
	@media (max-width: 720px) {
		.chart :global(text) {
			font-size: var(--label-mobile);
		}
		.chart :global(.chart-alt) {
			display: none;
		}
	}
</style>
