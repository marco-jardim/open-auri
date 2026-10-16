<script lang="ts">
	import { resolve } from '$app/paths';
	import { m } from '#lib/paraglide/messages.js';
</script>

<svelte:head>
	<title>{m.pwa_offline_title()} · Open Auri</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main aria-labelledby="offline-title">
	<h1 id="offline-title">{m.pwa_offline_title()}</h1>
	<p>{m.pwa_offline_description()}</p>
	<a href={resolve('/')}>{m.pwa_offline_editor()}</a>
</main>

<style>
	main {
		max-width: 640px;
		margin: 64px auto;
		padding: 24px;
		color: var(--text, #ece7dd);
	}
	h1 {
		font: 400 40px/1.2 var(--serif, Georgia, serif);
	}
	p {
		font: 16px/1.6 var(--sans, system-ui, sans-serif);
	}
	a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: inherit;
		text-decoration: underline;
		text-underline-offset: 4px;
	}
	a:focus-visible {
		outline: 2px solid currentColor;
		outline-offset: 4px;
	}
</style>
