<!--
	Error page (FUX.P11). The status code is the hero, as a large readout in a recessed well; a
	plain-language message under it; ways back to Curva and Docs. Never shows the error message,
	stack or any detail: those can carry internals and say nothing useful to a listener.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { m } from '#lib/paraglide/messages.js';
	import LazyArt from '#lib/components/art/LazyArt.svelte';

	const notFound = $derived(page.status === 404);
</script>

<svelte:head>
	<title>{page.status} · {m.layout_error_title()} · open-auri</title>
</svelte:head>

<main class="error-page" aria-labelledby="error-title">
	<LazyArt load={() => import('#lib/components/art/SignalArt.svelte')} />
	<div class="error-page__well">
		<p class="eyebrow error-page__label" id="error-status-label">{m.fux_p11_error_code_label()}</p>
		<p class="readout error-page__status" aria-describedby="error-status-label">{page.status}</p>
	</div>

	<h1 id="error-title" class="h-display-m">{m.layout_error_title()}</h1>
	<p class="lede">{notFound ? m.layout_error_not_found() : m.layout_error_generic()}</p>
	<p class="error-page__hint">
		{notFound ? m.fux_p11_error_not_found_hint() : m.fux_p11_error_generic_hint()}
	</p>

	<nav class="error-page__ways" aria-label={m.fux_p11_error_ways_label()}>
		<a class="error-page__way error-page__way--main" href={resolve('/')}
			>{m.layout_error_home()} <span aria-hidden="true">↗</span></a
		>
		<a class="error-page__way" href={resolve('/docs')}>{m.fux_p11_error_docs()}</a>
	</nav>
</main>

<style>
	.error-page {
		/* Holds the interrupted-signal art (SignalArt) in the top padding. */
		position: relative;
		isolation: isolate;
		display: grid;
		justify-items: start;
		gap: var(--space-5);
		width: 100%;
		max-width: 760px;
		margin: auto;
		padding: var(--section-gap) var(--gutter);
		color: var(--text);
	}

	/* The readout sits in a recessed well, like a display on the panel (spec §2.3). */
	.error-page__well {
		display: grid;
		gap: var(--space-2);
		padding: var(--space-4) var(--space-6);
		border-radius: var(--rad-2xl);
		background: var(--ink);
		box-shadow: var(--well);
	}

	.error-page__label {
		margin: 0;
		color: var(--muted);
	}

	.error-page__status {
		margin: 0;
		font-size: var(--fs-display-xl);
		line-height: 1;
		color: var(--accent-text);
	}

	h1 {
		margin-top: var(--space-4);
	}

	.lede,
	.error-page__hint {
		margin: 0;
		max-width: 60ch;
	}

	.error-page__hint {
		font-size: var(--fs-body);
		color: var(--muted);
	}

	.error-page__ways {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-5);
		margin-top: var(--space-4);
	}

	.error-page__way {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		min-height: var(--hit);
		font-family: var(--face-body);
		font-size: var(--fs-ui);
		font-weight: 500;
		color: var(--text);
		text-decoration: underline;
		text-decoration-color: var(--rule-control);
		text-underline-offset: 4px;
		transition: text-decoration-color var(--dur-fast) var(--ease-out);
	}

	.error-page__way--main {
		color: var(--accent-text);
	}

	.error-page__way:hover {
		text-decoration-color: currentColor;
	}

	.error-page__way:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 3px;
		border-radius: var(--rad-xs);
	}

	@media (prefers-reduced-motion: reduce) {
		.error-page__way {
			transition: none;
		}
	}
</style>
