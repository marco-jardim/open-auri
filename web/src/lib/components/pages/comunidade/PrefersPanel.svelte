<!--
	"Comunidade prefere": the published Bradley–Terry scores of the anonymous S6 pairs
	(`GET /api/v1/s6/preferences`, computed daily on the server). Curves are matched to the console by
	curve id; unknown ids show the id itself. Offline shows a notice, never an empty list.
-->
<script lang="ts">
	import { formatNumber } from '#lib/components/cable/i18n.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { isSocialApiError, type S6Preferences, type SocialApi } from '#lib/social/index.ts';
	import { errorText, isUnreachable, type Channel } from './model.ts';

	let { api, channels, online }: { api: SocialApi; channels: Channel[]; online: boolean } =
		$props();

	const id = $props.id();
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
			if (isSocialApiError(error) && error.code === 'NOT_FOUND') {
				status = 'empty';
			} else if (isUnreachable(error)) {
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

<section class="panel prefers" aria-labelledby="{id}-title">
	<div class="sec-head">
		<h2 id="{id}-title">{m.comunidade_prefers_title()}</h2>
		<p>{m.comunidade_prefers_lede()}</p>
	</div>
	{#if status === 'loading'}
		<p class="note" role="status">{m.comunidade_loading()}</p>
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
</section>

<style>
	.prefers {
		background: linear-gradient(180deg, #23292a, #181c1d);
	}
	.ranking {
		margin: 0;
		padding-left: 22px;
		display: grid;
		gap: 6px;
		font: 12px var(--mono);
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
	}
	.count {
		color: #a99f90;
	}
</style>
