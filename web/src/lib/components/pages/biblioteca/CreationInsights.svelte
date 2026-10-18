<script lang="ts">
	// Audience and share funnel of one of the user's creations (T4.14). Audience: counts per kind,
	// public names only, the rest as "N pessoas com perfil privado". Funnel: the account's shares
	// of this lineage (`GET /me/shares`), opens per UTC day and attributed actions.
	import { untrack } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import type { Audience, ShareFunnel, SocialApi } from '#lib/social/index.ts';
	import { errorKind, isAbort, sharesOf, type ErrorKind } from './social.ts';

	let {
		lineageId,
		name,
		verified,
		api,
		origin
	}: {
		lineageId: string;
		name: string;
		verified: boolean;
		api: Pick<SocialApi, 'audience' | 'shareStats' | 'createShare' | 'myShares'>;
		origin: string;
	} = $props();
	const id = $props.id();

	let audience = $state.raw<Audience | null>(null);
	let audienceError = $state<ErrorKind | null>(null);
	let shareIds = $state.raw<string[]>([]);
	let sharesState = $state<'loading' | 'ready' | ErrorKind>('loading');
	let funnels = $state.raw<Record<string, ShareFunnel | ErrorKind>>({});
	let creating = $state(false);
	let createError = $state<ErrorKind | null>(null);
	let reload = $state(0);
	/** Lineage whose links, stats and create state are shown; a new `lineageId` starts over. */
	let shown: string | null = null;
	/** Bumped per lineage: a share created for an earlier lineage is not one of this one's. */
	let generation = 0;

	const groups = $derived([
		{ key: 'previewed', label: m.biblioteca_social_audience_previewed() },
		{ key: 'installed', label: m.biblioteca_social_audience_installed() },
		{ key: 'favorited', label: m.biblioteca_social_audience_favorited() }
	] as const);

	$effect(() => {
		void reload;
		const controller = new AbortController();
		audience = null;
		audienceError = null;
		api.audience(lineageId, { signal: controller.signal }).then(
			(answer) => {
				if (controller.signal.aborted) return;
				audience = answer.audience;
			},
			(error: unknown) => {
				if (controller.signal.aborted || isAbort(error)) return;
				audienceError = errorKind(error);
			}
		);
		return () => controller.abort();
	});

	$effect(() => {
		void reload;
		const target = lineageId;
		const controller = new AbortController();
		if (target !== shown) {
			// Another lineage: none of the previous one's links, stats or create state carry over.
			shown = target;
			generation += 1;
			shareIds = [];
			funnels = {};
			creating = false;
			createError = null;
		}
		sharesState = 'loading';
		sharesOf(api, target, controller.signal).then(
			(shares) => {
				// A late answer for an earlier lineage (or a reload) is not this list's.
				if (controller.signal.aborted) return;
				// Keep links created meanwhile (they are already at the top).
				const created = untrack(() => shareIds);
				shareIds = [...new Set([...created, ...shares.map((share) => share.id)])];
				sharesState = 'ready';
			},
			(error: unknown) => {
				if (controller.signal.aborted || isAbort(error)) return;
				sharesState = errorKind(error);
			}
		);
		return () => controller.abort();
	});

	$effect(() => {
		void reload;
		void lineageId;
		const client = api;
		const controller = new AbortController();
		const requested: Record<string, true> = {};
		// Adding a share must not abort in-flight stats or refetch existing shares. Only an
		// explicit reload, a new lineage (or a new API) resets this request set and its controller.
		$effect(() => {
			for (const shareId of shareIds) {
				if (requested[shareId]) continue;
				requested[shareId] = true;
				client.shareStats(shareId, { signal: controller.signal }).then(
					(funnel) => {
						if (controller.signal.aborted) return;
						funnels = { ...funnels, [shareId]: funnel };
					},
					(error: unknown) => {
						if (controller.signal.aborted || isAbort(error)) return;
						funnels = { ...funnels, [shareId]: errorKind(error) };
					}
				);
			}
		});
		return () => controller.abort();
	});

	async function createShare() {
		if (creating || !verified) return;
		const token = generation;
		creating = true;
		createError = null;
		try {
			const created = await api.createShare({ lineageId, channel: 'link' });
			// Created for a lineage that is no longer shown: not one of this lineage's links.
			if (token !== generation) return;
			shareIds = [created.shareId, ...shareIds.filter((other) => other !== created.shareId)];
		} catch (error) {
			if (token === generation) createError = errorKind(error);
		} finally {
			if (token === generation) creating = false;
		}
	}

	function errorText(kind: ErrorKind): string {
		switch (kind) {
			case 'offline':
				return m.biblioteca_social_offline();
			case 'auth':
				return m.biblioteca_social_error_auth();
			case 'verify':
				return m.biblioteca_social_verify();
			case 'rate':
				return m.biblioteca_social_error_rate();
			case 'missing':
				return m.biblioteca_social_error_missing();
			default:
				return m.biblioteca_social_error_generic();
		}
	}
</script>

<div class="insights">
	<section aria-labelledby="{id}-audience">
		<h4 id="{id}-audience">{m.biblioteca_social_audience_title({ name })}</h4>
		{#if audienceError}
			<p role="alert">{errorText(audienceError)}</p>
			<button
				type="button"
				onclick={() => {
					reload += 1;
				}}>{m.biblioteca_social_retry()}</button
			>
		{:else if !audience}
			<p aria-busy="true">{m.biblioteca_social_loading()}</p>
		{:else}
			<dl class="audience">
				{#each groups as group (group.key)}
					{@const data = audience[group.key]}
					<div>
						<dt>{group.label}</dt>
						<dd>
							<span class="total">{m.biblioteca_social_audience_total({ count: data.total })}</span>
							{#if data.named.length > 0}<ul>
									{#each data.named as person (person.username)}
										<li>
											<a href="/u/{encodeURIComponent(person.username)}">{person.displayUsername}</a
											>
										</li>
									{/each}
								</ul>{/if}
							{#if data.privateCount > 0}<span class="private"
									>{m.biblioteca_social_audience_private({ count: data.privateCount })}</span
								>{/if}
						</dd>
					</div>
				{/each}
			</dl>
		{/if}
	</section>
	<section aria-labelledby="{id}-funnel">
		<h4 id="{id}-funnel">{m.biblioteca_social_funnel_title()}</h4>
		<p class="note">{m.biblioteca_social_funnel_note_account()}</p>
		{#if sharesState === 'loading' && shareIds.length === 0}
			<p aria-busy="true">{m.biblioteca_social_loading()}</p>
		{:else if sharesState !== 'loading' && sharesState !== 'ready'}
			<p role="alert">{errorText(sharesState)}</p>
		{:else if shareIds.length === 0}<p>{m.biblioteca_social_funnel_empty()}</p>{/if}
		{#each shareIds as shareId (shareId)}
			{@const funnel = funnels[shareId]}
			{@const href = `${origin}/c/${encodeURIComponent(lineageId)}?s=${encodeURIComponent(shareId)}`}
			<article class="share" aria-label={m.biblioteca_social_funnel_share({ id: shareId })}>
				<a class="link" {href}>{href}</a>
				{#if funnel === undefined}
					<p aria-busy="true">{m.biblioteca_social_loading()}</p>
				{:else if typeof funnel === 'string'}
					<p role="alert">{errorText(funnel)}</p>
				{:else}
					<p>{m.biblioteca_social_funnel_opens({ count: funnel.opens.total })}</p>
					{#if funnel.opens.days.length > 0}<ul class="days">
							{#each funnel.opens.days as day (day.day)}
								<li>{m.biblioteca_social_funnel_day({ day: day.day, count: day.count })}</li>
							{/each}
						</ul>{/if}
					<p>
						{m.biblioteca_social_funnel_attributed({
							previewed: funnel.attributed.previewed,
							installed: funnel.attributed.installed,
							favorited: funnel.attributed.favorited
						})}
					</p>
				{/if}
			</article>
		{/each}
		{#if verified}
			<button type="button" disabled={creating} onclick={createShare}
				>{m.biblioteca_social_funnel_create()}</button
			>
		{:else}
			<p>{m.biblioteca_social_verify()}</p>
		{/if}
		{#if createError}<p role="alert">{errorText(createError)}</p>{/if}
	</section>
</div>

<style>
	.insights {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 18px;
		padding: 14px;
		margin-top: 10px;
		background: #1f1a14;
		border: 1px solid #84604155;
		color: #e0cdae;
		font:
			11px/1.7 'JetBrains Mono',
			monospace;
	}
	h4 {
		margin: 0 0 8px;
		color: #ede0bf;
		font:
			700 15px 'Courier Prime',
			monospace;
	}
	p,
	ul,
	dl,
	dd {
		margin: 0;
	}
	ul {
		padding-left: 16px;
	}
	.audience > div {
		padding: 6px 0;
		border-top: 1px solid #b99c6a33;
	}
	dt {
		color: #f4c66e;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.total,
	.private {
		display: block;
	}
	.private,
	.note {
		color: #cdbb98;
	}
	.share {
		padding: 8px 0;
		border-top: 1px solid #b99c6a33;
	}
	a {
		color: inherit;
		text-underline-offset: 3px;
		overflow-wrap: anywhere;
	}
	.link {
		display: block;
	}
	button {
		min-height: 36px;
		margin-top: 8px;
		padding: 8px 12px;
		border: 1px solid #b5ae9477;
		border-radius: 2px;
		background: #272d23;
		color: #ece7dd;
		cursor: pointer;
		font-family: inherit;
	}
	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	:where(button, a):focus-visible {
		outline: 3px solid #f6bd55;
		outline-offset: 4px;
	}
	@media (max-width: 780px) {
		.insights {
			grid-template-columns: 1fr;
		}
	}
</style>
