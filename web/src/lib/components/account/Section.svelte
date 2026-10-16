<script lang="ts">
	import type { Snippet } from 'svelte';
	import './account.css';

	interface Props {
		/** Fragment id (`/conta#seguranca`). */
		id: string;
		title: string;
		description?: string;
		tone?: 'default' | 'danger';
		children: Snippet;
	}

	let { id, title, description, tone = 'default', children }: Props = $props();
</script>

<section {id} class="section" class:danger={tone === 'danger'} aria-labelledby="{id}-title">
	<header>
		<h2 id="{id}-title">{title}</h2>
		{#if description}<p>{description}</p>{/if}
	</header>
	<div class="body">
		{@render children()}
	</div>
</section>

<style>
	.section {
		display: grid;
		gap: var(--space-4, 16px);
		padding: var(--space-5, 24px);
		border: 1px solid var(--rule, rgba(236, 231, 221, 0.12));
		border-radius: var(--rad-md, 4px);
		background: var(--ink-2, #171715);
		scroll-margin-top: calc(var(--bar-h, 56px) + 16px);
	}

	.danger {
		border-color: rgba(229, 72, 77, 0.45);
	}

	h2 {
		margin: 0;
		color: var(--text, #ece7dd);
		font: 600 12px/1.4 var(--mono, 'JetBrains Mono', monospace);
		letter-spacing: var(--tracking-caps, 0.14em);
		text-transform: uppercase;
	}

	header p {
		margin: 6px 0 0;
		color: var(--state-text, #b5afa4);
		font: 13px/1.55 var(--ui, 'Geist', system-ui, sans-serif);
		max-width: 68ch;
	}

	.body {
		display: grid;
		gap: var(--space-5, 24px);
	}

	@media (max-width: 640px) {
		.section {
			padding: var(--space-4, 16px);
		}
	}
</style>
