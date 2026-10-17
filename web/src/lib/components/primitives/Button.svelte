<!--
	Button (design system v2.1, spec §2.6). Variants primary, plate, ghost, danger, key (LED
	from real state only) and lever (physical confirmation only); sizes sm 28, md 36, lg 44.
	Geist 500, never mono (T4).

	Unavailable always says why (T8): there is no `disabled` prop. `disabledReason` sets
	aria-disabled="true", keeps the button focusable, blocks activation (and form submission),
	shows the reason in a Tooltip on hover, keyboard focus or click/tap, and links it with
	aria-describedby so screen readers announce it.

	`loading` sets aria-busy, blocks activation and shows a spinner over the label, whose box
	keeps the button's width.
-->
<script module lang="ts">
	export type ButtonVariant = 'primary' | 'plate' | 'ghost' | 'danger' | 'key' | 'lever';
	export type ButtonSize = 'sm' | 'md' | 'lg';
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import Tooltip from './Tooltip.svelte';

	interface Props extends Omit<HTMLButtonAttributes, 'disabled' | 'children'> {
		variant?: ButtonVariant;
		size?: ButtonSize;
		/**
		 * Why the action is unavailable right now. Non-empty: aria-disabled, still focusable,
		 * reason announced. Empty or absent: the button acts.
		 */
		disabledReason?: string | null;
		/** Not supported on purpose: pass `disabledReason` instead. */
		disabled?: never;
		loading?: boolean;
		/** Upper case in the page's engraving face (spec §2.6). */
		caps?: boolean;
		/** Key variant: LED state, from real state only. */
		lit?: boolean;
		/** Square icon-only button (IconButton sets it; requires aria-label). */
		icon?: boolean;
		element?: HTMLButtonElement;
		children: Snippet;
	}

	let {
		variant = 'plate',
		size = 'md',
		disabledReason = null,
		loading = false,
		caps = false,
		lit = false,
		icon = false,
		element = $bindable(),
		type = 'button',
		class: className,
		onclick,
		children,
		...rest
	}: Props = $props();

	const uid = $props.id();
	const tipId = `${uid}-reason`;
	const reason = $derived(disabledReason?.trim() ? disabledReason.trim() : null);
	const describedBy = $derived(
		[rest['aria-describedby'], reason ? tipId : null].filter(Boolean).join(' ') || undefined
	);
	let tipOpen = $state(false);

	function handleClick(event: MouseEvent & { currentTarget: EventTarget & HTMLButtonElement }) {
		if (reason || loading) {
			event.preventDefault();
			event.stopImmediatePropagation();
			// Touch and mouse users get the reason too, not only hover and keyboard users.
			if (reason) tipOpen = true;
			return;
		}
		onclick?.(event);
	}
</script>

<button
	{...rest}
	bind:this={element}
	{type}
	class={[
		'btn',
		`btn--${variant}`,
		`btn--${size}`,
		caps && 'btn--caps',
		icon && 'btn--icon',
		className
	]}
	aria-disabled={reason ? 'true' : undefined}
	aria-busy={loading ? 'true' : undefined}
	aria-describedby={describedBy}
	onclick={handleClick}
>
	{#if variant === 'key'}<span class="btn__led" data-on={lit} aria-hidden="true"></span>{/if}
	<span class="btn__label">{@render children()}</span>
	{#if loading}<span class="btn__spinner" aria-hidden="true"></span>{/if}
</button>
{#if reason}
	<Tooltip id={tipId} text={reason} anchor={element} bind:open={tipOpen} />
{/if}
