<!--
	Turnstile on an auth form. The token travels as the `cf-turnstile-response` form field; the
	action forwards it in the `x-turnstile-token` header. Tokens are single use: `resetKey` changes
	after every enhanced submission so the widget renders again with a fresh token. Without a site
	key (tests, misconfiguration) only the empty field is rendered and the server refuses the
	attempt with the uniform "security check" message.
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import Turnstile from '#lib/components/security/Turnstile.svelte';
	import { TURNSTILE_FIELD } from './fields.ts';

	interface Props {
		siteKey: string;
		/** TURNSTILE_ACTIONS value checked by the server for this form. */
		action: string;
		resetKey?: number;
	}

	let { siteKey, action, resetKey = 0 }: Props = $props();
</script>

<div class="human-check">
	{#if siteKey}
		{#key resetKey}
			<Turnstile
				{siteKey}
				{action}
				name={TURNSTILE_FIELD}
				theme="dark"
				language={getLocale().toLowerCase()}
			/>
		{/key}
	{:else}
		<input type="hidden" name={TURNSTILE_FIELD} value="" />
	{/if}
	<noscript><p class="noscript">{m.auth_turnstile_noscript()}</p></noscript>
</div>

<style>
	.human-check {
		margin-top: 16px;
	}

	.noscript {
		margin: 6px 0 0;
		font-size: 12px;
		color: #ffd1ca;
	}
</style>
