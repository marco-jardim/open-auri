<script lang="ts">
	import { Field } from '#lib/components/primitives/index.ts';

	interface Props {
		error?: string | null;
	}

	let { error = null }: Props = $props();
</script>

<Field label="Preamp" hint="De −25,5 a −0,5 dB." unit="dB" required {error}>
	{#snippet children(control)}<input type="text" {...control} />{/snippet}
</Field>
