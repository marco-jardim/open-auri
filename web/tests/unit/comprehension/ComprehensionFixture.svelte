<script lang="ts">
	import { Tour, TourTrigger } from '#lib/components/comprehension/index.ts';
	import type { TourController } from '#lib/comprehension/tour.svelte.ts';
	let { controller, autoOpen = false }: { controller: TourController; autoOpen?: boolean } =
		$props();
	let clicks = $state(0);
</script>

<div class="fixture">
	<TourTrigger page="curva" {controller} />
	<button type="button" onclick={() => clicks++}>Background {clicks}</button>
	<div class="target" data-tour="curva-layers">Layer control</div>
	<div class="target" data-tour="curva-chart">Chart</div>
	<Tour page="curva" {controller} {autoOpen} />
</div>

<style>
	.fixture {
		padding: 24px;
	}
	.target {
		width: 120px;
		height: 80px;
		margin-top: 80px;
	}
</style>
