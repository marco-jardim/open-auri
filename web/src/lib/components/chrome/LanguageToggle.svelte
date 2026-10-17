<!--
	Language toggle. `compact` (the bar, FUX.NAV): a square bar button with the code of the
	language it switches to and a tooltip. `full` (the mobile menu sheet): "PT · EN" with the
	current one underlined. Both switch through Paraglide (which reloads the page), never while
	a cable write sends bytes: then the click is refused and the reason shows and is announced.
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale, setLocale } from '#lib/paraglide/runtime.js';
	import { isWriteInProgress, onWriteProgress } from '#lib/cable/write-flag.ts';
	import Tooltip from '#lib/components/primitives/Tooltip.svelte';

	interface Props {
		variant?: 'compact' | 'full';
	}

	let { variant = 'compact' }: Props = $props();

	let locale = $state(getLocale());
	/** Switching the locale reloads the page: never while a cable write sends bytes. */
	let writing = $state(isWriteInProgress());
	let button: HTMLButtonElement | undefined = $state();
	let reasonOpen = $state(false);
	const uid = $props.id();
	const reasonId = `${uid}-blocked`;
	const target = $derived(locale === 'pt-BR' ? 'en-US' : 'pt-BR');
	const switchLabel = $derived(m.chrome_language_switch({}, { locale }));
	$effect(() => {
		writing = isWriteInProgress();
		return onWriteProgress(() => {
			writing = isWriteInProgress();
		});
	});

	function toggle() {
		if (isWriteInProgress()) {
			// Refused, nothing else happens: the user switches after the write. The reason shows.
			writing = true;
			reasonOpen = true;
			return;
		}
		locale = locale === 'pt-BR' ? 'en-US' : 'pt-BR';
		return setLocale(locale);
	}
</script>

<button
	bind:this={button}
	type="button"
	class={[
		'language',
		`language--${variant}`,
		variant === 'compact' && 'btn btn--plate btn--sm btn--bar btn--icon'
	]}
	lang={target}
	aria-disabled={writing ? 'true' : undefined}
	aria-describedby={writing ? reasonId : undefined}
	onclick={toggle}
>
	{#if variant === 'compact'}
		<span class="code" lang={target}>{target === 'en-US' ? 'EN' : 'PT'}</span>
	{:else}
		<span lang="pt-BR" class:on={locale === 'pt-BR'}>PT</span>
		<span aria-hidden="true">·</span>
		<span lang="en-US" class:on={locale === 'en-US'}>EN</span>
	{/if}
	<span class="sr-only">{switchLabel}</span>
</button>
{#if writing || variant === 'compact'}
	<!-- Compact: the tooltip names the action; during a write it says why it waits (T8). -->
	<Tooltip
		id={reasonId}
		text={writing ? m.chrome_language_blocked() : switchLabel}
		anchor={button}
		bind:open={reasonOpen}
	/>
{/if}

<style>
	.language {
		flex: 0 0 auto;
		flex-wrap: nowrap;
		white-space: nowrap;
		cursor: pointer;
	}

	/* Compact: an action, so Geist (T4); the bar button recipe gives face and size. */
	.language--compact .code {
		font: 600 var(--label-min) / 1 var(--face-body);
		letter-spacing: var(--tracking-caps);
	}

	/* Full (sheet): data-like pair; weight stays at 400 (mono never above 500). */
	.language--full {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		min-width: 88px;
		min-height: 44px;
		padding: 0 var(--space-3);
		border: 1px solid var(--rule-control);
		border-radius: var(--rad-sm);
		background: color-mix(in srgb, var(--text) 4%, transparent);
		box-shadow: var(--bevel);
		color: var(--muted);
		font: 400 var(--fs-caption) / 1.2 var(--face-data);
		letter-spacing: var(--tracking-data);
	}

	.language--full:hover:not([aria-disabled='true']) {
		color: var(--text-2);
	}

	.language--full[aria-disabled='true'] {
		background: var(--lamp-off);
		box-shadow: none;
		cursor: not-allowed;
	}

	.on {
		color: var(--text);
		text-decoration: underline;
		text-decoration-color: var(--accent);
		text-underline-offset: 4px;
	}

	.language--full:focus-visible {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: var(--focus-offset);
	}
</style>
