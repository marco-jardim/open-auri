<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale, setLocale } from '#lib/paraglide/runtime.js';
	import { isWriteInProgress, onWriteProgress } from '#lib/cable/write-flag.ts';

	let locale = $state(getLocale());
	/** Switching the locale reloads the page: never while a cable write sends bytes. */
	let writing = $state(isWriteInProgress());
	$effect(() => {
		writing = isWriteInProgress();
		return onWriteProgress(() => {
			writing = isWriteInProgress();
		});
	});

	function toggle() {
		if (isWriteInProgress()) {
			// Refused, nothing else happens: the user switches after the write.
			writing = true;
			return;
		}
		locale = locale === 'pt-BR' ? 'en-US' : 'pt-BR';
		return setLocale(locale);
	}
</script>

<button
	type="button"
	class="language"
	lang={locale === 'pt-BR' ? 'en-US' : 'pt-BR'}
	aria-label={m.chrome_language_switch({}, { locale })}
	aria-disabled={writing ? 'true' : undefined}
	title={writing ? m.chrome_language_blocked() : undefined}
	onclick={toggle}
>
	<span lang="pt-BR" class:on={locale === 'pt-BR'}>PT</span>
	<span aria-hidden="true">·</span>
	<span lang="en-US" class:on={locale === 'en-US'}>EN</span>
</button>

<style>
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
		color: #aaa499;
		font: 11px/1.2 var(--mono, 'JetBrains Mono', monospace);
		white-space: nowrap;
		cursor: pointer;
	}

	.language[aria-disabled='true'] {
		cursor: not-allowed;
		opacity: 0.6;
	}

	.on {
		color: #ece7dd;
		text-decoration: underline;
		text-underline-offset: 4px;
	}

	button:focus-visible {
		outline: 2px solid var(--accent, #ff7a2f);
		outline-offset: 3px;
	}
</style>
