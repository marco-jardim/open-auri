<!--
	Blind trade (signed in, verified). Join the queue with one of your gate-approved publications,
	listen to the partner's curve blind (level matched against your editor curve; no name, no LEDs),
	score it 1 to 5; the partner is revealed once both scored. Waiting entries can be cancelled;
	unmatched entries expire after 72 h on the server. Without a verified account the page's single
	account card explains why; here the action only says it is unavailable and why (T8, T9).
-->
<script lang="ts">
	import { Explainer } from '#lib/components/comprehension/index.ts';
	import Button from '#lib/components/primitives/Button.svelte';
	import Panel from '#lib/components/primitives/Panel.svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import type { LibraryItem, SocialApi, TradeDto } from '#lib/social/index.ts';
	import { getHiddenStore } from '#lib/social/hidden-context.ts';
	import type { Listener } from './listener.svelte.ts';
	import {
		decodeCurve,
		errorText,
		formatDate,
		type DecodedCurve,
		type SessionView
	} from './model.ts';

	let {
		api,
		session,
		owned,
		editor,
		listener,
		canListen,
		online,
		onnotice
	}: {
		api: SocialApi;
		session: SessionView;
		owned: LibraryItem[];
		editor: DecodedCurve | null;
		listener: Listener;
		canListen: boolean;
		online: boolean;
		onnotice: (message: string) => void;
	} = $props();

	const id = $props.id();
	const hidden = getHiddenStore();
	// Blind partners have no public identity until both score. Do not bypass a viewer's
	// preferences through anonymous audio: pause trades while their targets cannot be checked.
	const contentAllowed = $derived($hidden.ready && !$hidden.authors.length && !$hidden.curves.length);
	$effect(() => {
		if (!contentAllowed && listener.owner === 's7') listener.stop();
	});
	let trades = $state.raw<TradeDto[]>([]);
	let choice = $state('');
	let busy = $state(false);
	let message = $state('');
	let scores = $state<Record<string, number>>({});
	let listeningTo = $state('');

	const approved = $derived(
		owned.filter(
			(item) => item.curve.gateOk && item.status === 'active' && item.visibility !== 'private'
		)
	);
	const joinReason = $derived(
		!session.verified
			? session.signedIn
				? m.comunidade_verify_prompt()
				: m.comunidade_v2_reason_account()
			: !online
				? m.comunidade_offline()
				: busy
					? m.comunidade_v2_reason_wait()
					: null
	);

	$effect(() => {
		if (!choice && approved[0]) choice = approved[0].id;
	});

	$effect(() => {
		if (session.verified && online) void refresh();
	});

	$effect(() => {
		if (listener.owner !== 's7') listeningTo = '';
	});

	async function refresh() {
		try {
			const page = await api.myTrades({ limit: 20 });
			trades = page.items;
		} catch (error) {
			message = errorText(error);
		}
	}

	async function join() {
		if (!choice || busy) return;
		busy = true;
		message = '';
		try {
			const { trade } = await api.joinTrade({ lineageId: choice });
			trades = [trade, ...trades.filter((item) => item.id !== trade.id)];
			message = m.comunidade_s7_joined();
		} catch (error) {
			message = errorText(error);
		} finally {
			busy = false;
		}
	}

	async function listen(trade: TradeDto) {
		if (listeningTo === trade.id) {
			listener.stop();
			return;
		}
		const partner = trade.partner ? decodeCurve(trade.partner.s1) : null;
		if (!partner || !editor || !canListen) {
			onnotice(m.comunidade_audio_unavailable());
			return;
		}
		try {
			await listener.play({
				a: { lineageId: null, curve: editor },
				b: { lineageId: null, curve: partner },
				initial: 'B',
				blind: true,
				owner: 's7'
			});
			listeningTo = trade.id;
		} catch (error) {
			onnotice(m.comunidade_audio_error());
			console.warn(
				JSON.stringify({
					event: 'comunidade.s7_listen_failed',
					error: error instanceof Error ? error.name : 'unknown'
				})
			);
		}
	}

	function isScore(value: number): value is 1 | 2 | 3 | 4 | 5 {
		return Number.isInteger(value) && value >= 1 && value <= 5;
	}

	async function score(trade: TradeDto) {
		const value = scores[trade.id] ?? 1;
		if (!isScore(value) || busy) return;
		busy = true;
		message = '';
		try {
			const result = await api.scoreTrade(trade.id, value);
			trades = trades.map((item) => (item.id === trade.id ? result.trade : item));
			message = result.revealed ? m.comunidade_s7_revealed() : m.comunidade_s7_scored();
			if (listeningTo === trade.id) listener.stop();
		} catch (error) {
			message = errorText(error);
		} finally {
			busy = false;
		}
	}

	async function cancel(trade: TradeDto) {
		busy = true;
		message = '';
		try {
			await api.cancelTrade(trade.id);
			trades = trades.map((item): TradeDto =>
				item.id === trade.id ? { ...item, status: 'cancelled' } : item
			);
		} catch (error) {
			message = errorText(error);
		} finally {
			busy = false;
		}
	}

	function statusText(trade: TradeDto): string {
		switch (trade.status) {
			case 'waiting':
				return m.comunidade_s7_status_waiting();
			case 'matched':
				return m.comunidade_s7_status_matched();
			case 'revealed':
				return m.comunidade_s7_status_revealed();
			case 'expired':
				return m.comunidade_s7_status_expired();
			case 'cancelled':
				return m.comunidade_s7_status_cancelled();
		}
	}
</script>

<Panel
	variant="hardware"
	class="desk-panel"
	title={m.comunidade_s7_title()}
	data-testid="s7-panel"
	style="--panel-material: linear-gradient(180deg, #2a2d31, #1d1f22)"
>
	{#snippet explain()}<Explainer term="s7" />{/snippet}
	<p class="panel-lede">{m.comunidade_s7_lede()}</p>
	{#if !session.verified}
		<div class="join">
			<Button variant="primary" disabledReason={joinReason}>{m.comunidade_s7_join()}</Button>
		</div>
	{:else}
		<div class="join">
			{#if approved.length === 0}
				<p class="note">{m.comunidade_s7_need_approved()}</p>
			{:else}
				<label>
					<span class="fld-lbl">{m.comunidade_s7_curve()}</span>
					<select class="desk-select" bind:value={choice}>
						{#each approved as item (item.id)}
							<option value={item.id}>{item.head.name}</option>
						{/each}
					</select>
				</label>
				<Button variant="primary" disabledReason={joinReason} onclick={join}
					>{m.comunidade_s7_join()}</Button
				>
			{/if}
		</div>
		{#if !contentAllowed}
			<p class="note">{m.hidden_content()}</p>
		{:else if trades.length === 0}
			<p class="note">{m.comunidade_s7_none()}</p>
		{:else}
			<ul class="trades" aria-label={m.comunidade_s7_title()}>
				{#each trades as trade (trade.id)}
					<li>
						<div class="trade-head">
							<span class="status">{statusText(trade)}</span>
							<span class="date">{formatDate(trade.createdAt, getLocale())}</span>
						</div>
						{#if trade.status === 'matched' && trade.partner}
							<div class="row-btns">
								<Button aria-pressed={listeningTo === trade.id} onclick={() => listen(trade)}
									>{listeningTo === trade.id
										? m.comunidade_stop()
										: m.comunidade_s7_listen_blind()}</Button
								>
								{#if trade.score === null}
									<label class="score" for="{id}-score-{trade.id}">
										<span>{m.comunidade_s7_score()}</span>
									</label>
									<select
										id="{id}-score-{trade.id}"
										class="desk-select"
										bind:value={scores[trade.id]}
									>
										{#each [1, 2, 3, 4, 5] as value (value)}
											<option {value}>{value}</option>
										{/each}
									</select>
									<Button
										variant="primary"
										disabledReason={busy ? m.comunidade_v2_reason_wait() : null}
										onclick={() => score(trade)}>{m.comunidade_s7_send_score()}</Button
									>
								{:else}
									<span class="note">{m.comunidade_s7_waiting_partner()}</span>
								{/if}
							</div>
						{:else if trade.status === 'revealed' && trade.partner?.revealed}
							<p class="reveal">
								{#if trade.partner.username}
									<a href="/u/{encodeURIComponent(trade.partner.username)}"
										>@{trade.partner.nickname ?? trade.partner.username}</a
									>
								{:else}
									{m.comunidade_author_removed()}
								{/if}
								{#if trade.partner.lineage}
									· <a href="/c/{encodeURIComponent(trade.partner.lineage.id)}"
										>{trade.partner.lineage.name ?? trade.partner.curveId}</a
									>
								{/if}
								· {m.comunidade_s7_their_score({
									score: trade.partner.score === null ? '–' : String(trade.partner.score)
								})}
							</p>
						{:else if trade.status === 'waiting'}
							<div class="row-btns">
								<Button
									size="sm"
									variant="ghost"
									disabledReason={busy ? m.comunidade_v2_reason_wait() : null}
									onclick={() => cancel(trade)}>{m.comunidade_s7_cancel()}</Button
								>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
		<p class="note" role="status">{message}</p>
	{/if}
</Panel>

<style>
	.join {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 10px;
		margin-bottom: var(--space-3);
	}
	.join label {
		display: flex;
		flex-direction: column;
	}
	.trades {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.trades li {
		padding: 10px;
		border: 1px solid var(--rule);
		border-radius: var(--rad-md);
		background: #ffffff06;
	}
	.trade-head {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		font: var(--fs-caption) var(--face-body);
	}
	.status {
		color: var(--accent-text);
		font-weight: 600;
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
	}
	.date {
		color: var(--muted-hi);
		font-family: var(--face-data);
		font-variant-numeric: tabular-nums slashed-zero;
	}
	.score {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font: var(--fs-caption) var(--face-body);
	}
	.reveal {
		margin: var(--space-2) 0 0;
		font-size: var(--fs-small);
		overflow-wrap: anywhere;
	}
	.reveal a {
		color: var(--accent-text);
	}
</style>
