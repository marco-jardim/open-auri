<!-- /criar-conta while SIGNUP_ENABLED=false: explanation only, no form. -->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { withNext } from './next.ts';

	interface Props {
		next?: string | null;
	}

	let { next = null }: Props = $props();
</script>

<div class="closed" data-signup="closed">
	<p class="lamp-row">
		<span class="lamp" aria-hidden="true"></span>
		<strong>{m.auth_signup_closed_status()}</strong>
	</p>
	<p>{m.auth_signup_closed_body()}</p>
	<p>{m.auth_signup_closed_existing()}</p>
	<p class="actions">
		<a class="primary" href={withNext('/entrar', next)}>{m.auth_signup_closed_signin()}</a>
		<a href="/">{m.auth_signup_closed_home()}</a>
	</p>
</div>

<style>
	.closed {
		margin-top: 8px;
		font-size: 14px;
		line-height: 1.55;
	}

	p {
		margin: 10px 0 0;
		color: var(--strip-muted, #a9b2bd);
	}

	.lamp-row {
		display: flex;
		align-items: center;
		gap: 10px;
		color: var(--strip-text, #e3e7ec);
		font: 600 13px/1.3 var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.16em;
		text-transform: uppercase;
	}

	.lamp {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--lamp-warn, #f2b33d);
		box-shadow: 0 0 6px var(--lamp-warn, #f2b33d);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px 18px;
		margin-top: 18px;
	}

	a {
		color: var(--strip-text, #e3e7ec);
	}

	a.primary {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0 16px;
		border: 1px solid color-mix(in srgb, var(--accent) 70%, black);
		border-radius: var(--rad-sm, 3px);
		background: var(--accent);
		color: var(--accent-ink, #0f0f0e);
		font: 700 13px/1 var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.16em;
		text-decoration: none;
		text-transform: uppercase;
	}

	a:focus-visible {
		outline: 2px solid var(--strip-text, #e3e7ec);
		outline-offset: 3px;
	}
</style>
