<script lang="ts">
	import Button from '#lib/components/primitives/Button.svelte';
	let { text }: { text: string } = $props();
</script>

<Button disabledReason={text}>Unavailable</Button>
