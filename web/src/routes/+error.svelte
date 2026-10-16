<script lang="ts">
	import { page } from '$app/state';
	import { m } from '#lib/paraglide/messages.js';
</script>

<svelte:head>
	<title>{page.status} · {m.layout_error_title()} · open-auri</title>
</svelte:head>

<main class="error-page" aria-labelledby="error-title">
	<p class="status mono">{page.status}</p>
	<h1 id="error-title">{m.layout_error_title()}</h1>
	<p>{page.status === 404 ? m.layout_error_not_found() : m.layout_error_generic()}</p>
	{#if page.error?.message}
		<p class="detail">{page.error.message}</p>
	{/if}
	<a href="/">{m.layout_error_home()} ↗</a>
</main>

<style>
	.error-page {
		max-width: 760px;
		margin: auto;
		padding: clamp(40px, 12vw, 140px) var(--gutter);
	}
	.status {
		color: var(--accent);
		font-size: 24px;
	}
	h1 {
		margin-block: 16px 24px;
		font-size: clamp(40px, 8vw, 72px);
	}
	p {
		margin-block: 16px;
	}
	.detail {
		overflow-wrap: anywhere;
		color: var(--state-text);
	}
	a {
		display: inline-block;
		margin-top: 24px;
		color: var(--accent);
	}
</style>
