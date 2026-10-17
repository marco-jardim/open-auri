<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import '#lib/components/account/account.css';
</script>

<svelte:head>
	<title>{m.conta_closed_title()} · open-auri</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<!-- Where Better Auth sends the browser after the closure link deleted the account. -->
<div class="closed">
	<h1>{m.conta_closed_title()}</h1>
	<p>{m.conta_closed_body()}</p>
	<p>{m.conta_closed_local()}</p>
	<p><a class="acc-link" href="/">{m.conta_closed_home()}</a></p>
</div>

<style>
	.closed {
		display: grid;
		gap: var(--space-3, 12px);
		width: min(100%, 640px);
		margin: 0 auto;
		padding: var(--space-7, 48px) var(--gutter, 24px) var(--space-8, 80px);
		color: var(--text, #ece7dd);
		font-family: var(--face-body, var(--ui, 'Geist', system-ui, sans-serif));
		font-size: var(--fs-body, 15px);
		line-height: var(--lh-body, 1.55);
	}

	h1 {
		margin: 0;
		font-family: var(--face-display, var(--serif, 'Instrument Serif', Georgia, serif));
		font-size: var(--fs-display-m, 40px);
		font-weight: 400;
		line-height: 1;
	}

	p {
		margin: 0;
		color: var(--state-text, #b5afa4);
	}
</style>
