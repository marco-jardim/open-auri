<!--
	IconButton: square Button for a glyph or SVG. The accessible name is mandatory (`label`
	becomes aria-label); the glyph itself is hidden from assistive technology. Same variants,
	sizes, disabledReason and loading behaviour as Button.
-->
<script lang="ts">
	import type { ComponentProps, Snippet } from 'svelte';
	import Button from './Button.svelte';

	type ButtonProps = ComponentProps<typeof Button>;

	interface Props extends Omit<ButtonProps, 'children' | 'icon' | 'aria-label'> {
		/** Accessible name (aria-label). */
		label: string;
		children: Snippet;
	}

	let { label, children, variant = 'plate', element = $bindable(), ...rest }: Props = $props();
</script>

<Button {...rest} {variant} icon aria-label={label} bind:element>
	<span class="btn__glyph" aria-hidden="true">{@render children()}</span>
</Button>
