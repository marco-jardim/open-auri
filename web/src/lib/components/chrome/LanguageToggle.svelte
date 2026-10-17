<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale, setLocale } from '#lib/paraglide/runtime.js';
	import { isWriteInProgress, onWriteProgress } from '#lib/cable/write-flag.ts';
	import { Tooltip } from '#lib/components/primitives/index.ts';

	let locale = $state(getLocale());
	/** Switching the locale reloads the page: never while a cable write sends bytes. */
	let writing = $state(isWriteInProgress());
	let button: HTMLButtonElement | undefined = $state();
	let reasonOpen = $state(false);
	const uid = $props.id();
	const reasonId = `${uid}-blocked`;
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
	class="language"
	lang={locale === 'pt-BR' ? 'en-US' : 'pt-BR'}
	aria-disabled={writing ? 'true' : undefined}
	aria-describedby={writing ? reasonId : undefined}
	onclick={toggle}
>
	<span lang="pt-BR" class:on={locale === 'pt-BR'}>PT</span>
	<span aria-hidden="true">·</span>
	<span lang="en-US" class:on={locale === 'en-US'}>EN</span>
	<span class="sr-only">{m.chrome_language_switch({}, { locale })}</span>
</button>
{#if writing}
	<Tooltip
		id={reasonId}
		text={m.chrome_language_blocked()}
		anchor={button}
		bind:open={reasonOpen}
	/>
{/if}

<style>
	/* Data-like toggle (mock: mono, borderless); weight stays at 400 (mono never above 500). */
	.language {
		display: inline-flex;
		flex: 0 0 auto;
		flex-wrap: nowrap;
		align-items: center;
		justify-content: center;
		gap: 5px;
		min-width: 64px;
		min-height: 44px;
		padding: 7px 4px;
		border: 0;
		background: transparent;
		color: var(--muted);
		font: 400 var(--label-min) / 1.2 var(--face-data);
		letter-spacing: var(--tracking-data);
		white-space: nowrap;
		cursor: pointer;
	}

	.language:hover:not([aria-disabled='true']) {
		color: var(--text-2);
	}

	.language[aria-disabled='true'] {
		background: var(--lamp-off);
		border-radius: var(--rad-sm);
		cursor: not-allowed;
	}

	.on {
		color: var(--text);
		text-decoration: underline;
		text-decoration-color: var(--accent);
		text-underline-offset: 4px;
	}

	button:focus-visible {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: var(--focus-offset);
	}
</style>
