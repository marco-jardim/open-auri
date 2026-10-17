<!-- Shown in place of a social action: sign in (comes back here) or verify the e-mail. -->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { requireLoginHref } from '#lib/social/index.ts';

	let { signedIn, path = '/comunidade' }: { signedIn: boolean; path?: string } = $props();
</script>

<div class="login-prompt" role="note" data-testid="login-prompt">
	{#if signedIn}
		<p>{m.comunidade_verify_prompt()}</p>
		<a href="/verificar-email">{m.comunidade_verify_link()}</a>
	{:else}
		<p>{m.comunidade_login_prompt()}</p>
		<a href={requireLoginHref(path)}>{m.comunidade_login_link()}</a>
	{/if}
</div>

<style>
	.login-prompt {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px 14px;
		padding: 10px 12px;
		border: 1px dashed #ffffff33;
		border-radius: 4px;
		background: #ffffff08;
		font: 12px/1.5 var(--sans);
		color: #e1dcd1;
	}
	p {
		margin: 0;
	}
	a {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
		min-width: 24px;
		color: var(--accent);
		font-weight: 600;
	}
</style>
