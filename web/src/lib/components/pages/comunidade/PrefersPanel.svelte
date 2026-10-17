<!--
	"Comunidade prefere": the published Bradley–Terry scores of the anonymous preference pairs
	(`GET /api/v1/s6/preferences`, computed daily on the server). Curves are matched to the console by
	curve id; unknown ids show the id itself. While loading, skeleton rows keep the list's geometry
	(spec §5.5); offline shows a notice, never an empty list.
-->
<script lang="ts">
	import { formatNumber } from '#lib/components/cable/i18n.ts';
	import Panel from '#lib/components/primitives/Panel.svelte';
	import { m } from '#lib/paraglide/messages.js';
	import type { S6Preferences, SocialApi } from '#lib/social/index.ts';
	import { errorText, isUnreachable, type Channel } from './model.ts';

	const SKELETON_ROWS = [1, 2, 3, 4, 5] as const;

	let { api, channels, online }: { api: SocialApi; channels: Channel[]; online: boolean } =
		$props();

	let data = $state.raw<S6Preferences | null>(null);
	let status = $state<'loading' | 'ready' | 'empty' | 'offline' | 'error'>('loading');
	let message = $state('');

	$effect(() => {
		if (!online) {
			if (!data) status = 'offline';
			return;
		}
		void load();
	});

	async function load() {
		status = 'loading';
		try {
			const result = await api.s6Preferences();
			data = result;
			status = result.items.length === 0 ? 'empty' : 'ready';
		} catch (error) {
			if (isUnreachable(error)) {
				status = 'offline';
			} else {
				status = 'error';
				message = errorText(error);
			}
		}
	}

	const names = $derived(new Map(channels.map((channel) => [channel.curveId, channel.name])));
	const top = $derived((data?.items ?? []).slice(0, 10));
</script>

<Panel
	variant="hardware"
	class="desk-panel"
	title={m.comunidade_prefers_title()}
	data-testid="prefers-panel"
	style="--panel-material: linear-gradient(180deg, #23292a, #181c1d)"
>
	<p class="panel-lede">{m.comunidade_prefers_lede()}</p>
	{#if status === 'loading'}
		<div class="skel-rows" role="status" aria-busy="true" data-testid="prefers-loading">
			<span class="sr-only">{m.comunidade_loading()}</span>
			{#each SKELETON_ROWS as row (row)}
				<span class="skeleton skel-row" aria-hidden="true"></span>
			{/each}
		</div>
	{:else if status === 'offline'}
		<p class="note" role="status">{m.comunidade_offline()}</p>
	{:else if status === 'error'}
		<p class="note" role="alert">{message}</p>
	{:else if status === 'empty'}
		<p class="note">{m.comunidade_prefers_empty()}</p>
	{:else}
		<ol class="ranking">
			{#each top as item (item.curveId)}
				<li>
					<span class="name">{names.get(item.curveId) ?? item.curveId}</span>
					<span class="score">{formatNumber(item.score, 2)}</span>
					<span class="count"
						>{m.comunidade_prefers_comparisons({ count: String(item.comparisons) })}</span
					>
				</li>
			{/each}
		</ol>
		{#if data}
			<p class="note">{m.comunidade_prefers_pairs({ count: String(data.pairs) })}</p>
		{/if}
	{/if}
</Panel>

<style>
	.skel-rows {
		display: grid;
		gap: 6px;
	}
	/* Same height as one ranking row (caption line height). */
	.skel-row {
		height: 18px;
	}
	.ranking {
		display: grid;
		gap: 6px;
		margin: 0;
		padding-left: 22px;
		font: var(--fs-caption) / var(--lh-small) var(--face-body);
	}
	.ranking li {
		display: grid;
		grid-template-columns: 1fr auto auto;
		gap: 10px;
	}
	.name {
		overflow-wrap: anywhere;
	}
	.score {
		color: var(--amber);
		font-family: var(--face-data);
		font-variant-numeric: tabular-nums slashed-zero;
	}
	.count {
		color: var(--muted-hi);
	}
</style>
