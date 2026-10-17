<!--
	Offline (FUX.P11, spec §1.9 and §5.7: static route, target ≤ 80 kB gzip). Calm and themed:
	display title, lede, a Panel saying what still works without a network, and "Tentar de novo".
	Imports only light primitives (direct files, not the barrel) and never `#lib/app/index.ts`:
	the app runtime keeps loading on idle from the layout (FUX.2), not from this page.
	The lamp is real state: the browser's own network flag (`navigator.onLine` and its events).
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { m } from '#lib/paraglide/messages.js';
	import Button from '#lib/components/primitives/Button.svelte';
	import Lamp from '#lib/components/primitives/Lamp.svelte';
	import Panel from '#lib/components/primitives/Panel.svelte';
	import LazyArt from '#lib/components/art/LazyArt.svelte';

	// Prerendered without a navigator: the page is served when the network is gone, so it
	// starts offline and hydration reads the real flag.
	let online = $state(false);

	$effect(() => {
		const sync = () => {
			online = navigator.onLine;
		};
		sync();
		window.addEventListener('online', sync);
		window.addEventListener('offline', sync);
		return () => {
			window.removeEventListener('online', sync);
			window.removeEventListener('offline', sync);
		};
	});

	const features = $derived([
		{
			id: 'editor',
			name: m.fux_p11_offline_item_editor(),
			hint: m.fux_p11_offline_item_editor_hint()
		},
		{
			id: 'cable',
			name: m.fux_p11_offline_item_cable(),
			hint: m.fux_p11_offline_item_cable_hint()
		},
		{
			id: 'preview',
			name: m.fux_p11_offline_item_preview(),
			hint: m.fux_p11_offline_item_preview_hint()
		},
		{ id: 'blind', name: m.fux_p11_offline_item_blind(), hint: m.fux_p11_offline_item_blind_hint() }
	]);

	function retry() {
		window.location.reload();
	}
</script>

<svelte:head>
	<title>{m.pwa_offline_title()} · Open Auri</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main class="offline" aria-labelledby="offline-title">
	<LazyArt load={() => import('#lib/components/art/SignalArt.svelte')} />
	<header class="offline__head">
		<p class="eyebrow offline__signal" role="status" data-online={online}>
			<Lamp on={online} tone={online ? 'ok' : 'warn'} />
			<span>{online ? m.fux_p11_offline_signal_back() : m.fux_p11_offline_signal_none()}</span>
		</p>
		<h1 id="offline-title" class="h-display-l">{m.pwa_offline_title()}</h1>
		<p class="lede">{m.pwa_offline_description()}</p>
	</header>

	<Panel
		class="offline__panel"
		eyebrow={m.fux_p11_offline_works_eyebrow()}
		title={m.fux_p11_offline_works_title()}
	>
		<ul class="offline__list">
			{#each features as feature (feature.id)}
				<li class="offline__item" data-feature={feature.id}>
					<span class="offline__mark" aria-hidden="true"></span>
					<span class="offline__text">
						<strong class="offline__name">{feature.name}</strong>
						<span class="offline__hint">{feature.hint}</span>
					</span>
				</li>
			{/each}
		</ul>
		<p class="offline__note">{m.fux_p11_offline_social_note()}</p>
	</Panel>

	<div class="offline__actions">
		<Button variant="primary" size="lg" onclick={retry}>{m.fux_p11_offline_retry()}</Button>
		<a class="offline__link" href={resolve('/')}>{m.pwa_offline_editor()}</a>
	</div>
</main>

<style>
	.offline {
		/* Holds the cut-tape art (SignalArt) in the top padding. */
		position: relative;
		isolation: isolate;
		display: grid;
		gap: var(--space-7);
		width: 100%;
		max-width: 720px;
		margin-inline: auto;
		padding: var(--section-gap) var(--gutter);
		color: var(--text);
	}

	.offline__head {
		display: grid;
		gap: var(--space-4);
	}

	.offline__signal {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		margin: 0;
		color: var(--muted);
	}

	.offline__signal[data-online='true'] {
		color: var(--text-2);
	}

	.lede {
		margin: 0;
		max-width: 60ch;
	}

	.offline__list {
		display: grid;
		gap: var(--space-4);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.offline__item {
		display: grid;
		grid-template-columns: auto 1fr;
		align-items: baseline;
		gap: var(--space-3);
	}

	/* A static check, not a Lamp: lamps are for live state only (spec §2.6). */
	.offline__mark {
		width: 10px;
		height: 6px;
		border-bottom: 2px solid var(--ok);
		border-left: 2px solid var(--ok);
		transform: translateY(-3px) rotate(-45deg);
	}

	.offline__text {
		display: grid;
		gap: var(--space-1);
	}

	.offline__name {
		font-family: var(--face-body);
		font-size: var(--fs-body);
		font-weight: 600;
		color: var(--text);
	}

	.offline__hint {
		font-size: var(--fs-ui);
		color: var(--text-2);
	}

	.offline__note {
		margin: var(--space-5) 0 0;
		padding-top: var(--space-4);
		border-top: 1px solid var(--rule);
		font-size: var(--fs-small);
		color: var(--muted);
	}

	.offline__actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-5);
	}

	.offline__link {
		display: inline-flex;
		align-items: center;
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

	.offline__link:hover {
		text-decoration-color: currentColor;
	}

	.offline__link:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 3px;
		border-radius: var(--rad-xs);
	}

	@media (prefers-reduced-motion: reduce) {
		.offline__link {
			transition: none;
		}
	}
</style>
