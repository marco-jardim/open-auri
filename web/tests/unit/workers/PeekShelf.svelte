<!-- Test shelf: one badge per curve, each reading `peek` in the template as Biblioteca does. -->
<script lang="ts">
	import type { Classifier, ClassifierCurve } from '#lib/workers/classifier.svelte.ts';

	let { classifier, curves }: { classifier: Classifier; curves: readonly ClassifierCurve[] } =
		$props();
</script>

<ul>
	{#each curves as curve, index (index)}
		<li data-class={classifier.peek(curve)?.class ?? 'pending'}>{index}</li>
	{/each}
</ul>
