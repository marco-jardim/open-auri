<script lang="ts">
	import { Tooltip } from '#lib/components/primitives/index.ts';

	interface Props {
		text: string;
		delay?: number;
	}

	let { text, delay }: Props = $props();
</script>

<p>Before</p>
<Tooltip {text} {delay}>
	{#snippet children(tip)}
		<button type="button" {@attach tip.attach} aria-describedby={tip.id}>Q</button>
	{/snippet}
</Tooltip>
<button type="button">After</button>
