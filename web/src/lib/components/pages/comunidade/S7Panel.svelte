<!--
	S7 · blind trade (signed in, verified). Join the queue with one of your gate-approved
	publications, listen to the partner's curve blind (level matched against your editor curve; no
	name, no LEDs), score it 1 to 5; the partner is revealed once both scored. Waiting entries can be
	cancelled; unmatched entries expire after 72 h on the server.
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import type { LibraryItem, SocialApi, TradeDto } from '#lib/social/index.ts';
	import type { Listener } from './listener.svelte.ts';
	import LoginPrompt from './LoginPrompt.svelte';
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

<section class="panel s7" aria-labelledby="{id}-title">
	<div class="sec-head">
		<h2 id="{id}-title">{m.comunidade_s7_title()}</h2>
		<p>{m.comunidade_s7_lede()}</p>
	</div>
	{#if !session.verified}
		<LoginPrompt signedIn={session.signedIn} />
	{:else}
		<div class="join">
			{#if approved.length === 0}
				<p class="note">{m.comunidade_s7_need_approved()}</p>
			{:else}
				<label>
					<span class="fld-lbl">{m.comunidade_s7_curve()}</span>
					<select bind:value={choice}>
						{#each approved as item (item.id)}
							<option value={item.id}>{item.head.name}</option>
						{/each}
					</select>
				</label>
				<button type="button" class="btn primary" disabled={busy || !online} onclick={join}
					>{m.comunidade_s7_join()}</button
				>
			{/if}
		</div>
		{#if trades.length === 0}
			<p class="note">{m.comunidade_s7_none()}</p>
		{:else}
			<ul class="trades">
				{#each trades as trade (trade.id)}
					<li>
						<div class="trade-head">
							<span class="status">{statusText(trade)}</span>
							<span class="date">{formatDate(trade.createdAt, getLocale())}</span>
						</div>
						{#if trade.status === 'matched' && trade.partner}
							<div class="row-btns">
								<button
									type="button"
									class="btn"
									aria-pressed={listeningTo === trade.id}
									onclick={() => listen(trade)}
									>{listeningTo === trade.id
										? m.comunidade_stop()
										: m.comunidade_s7_listen_blind()}</button
								>
								{#if trade.score === null}
									<label class="score">
										<span>{m.comunidade_s7_score()}</span>
										<select bind:value={scores[trade.id]}>
											{#each [1, 2, 3, 4, 5] as value (value)}
												<option {value}>{value}</option>
											{/each}
										</select>
									</label>
									<button
										type="button"
										class="btn primary"
										disabled={busy}
										onclick={() => score(trade)}>{m.comunidade_s7_send_score()}</button
									>
								{:else}
									<span class="note">{m.comunidade_s7_waiting_partner()}</span>
								{/if}
							</div>
						{:else if trade.status === 'revealed' && trade.partner?.revealed}
							<p class="reveal">
								{#if trade.partner.nickname}
									<a href="/u/{encodeURIComponent(trade.partner.nickname)}"
										>@{trade.partner.nickname}</a
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
							<button type="button" class="btn" disabled={busy} onclick={() => cancel(trade)}
								>{m.comunidade_s7_cancel()}</button
							>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
		<p class="note" role="status">{message}</p>
	{/if}
</section>

<style>
	.s7 {
		background: linear-gradient(180deg, #2a2d31, #1d1f22);
	}
	.join {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 10px;
		margin-bottom: 12px;
	}
	select {
		background: #0f0e0c;
		color: #ece7dd;
		border: 1px solid #000;
		padding: 6px 8px;
		font: 12px var(--mono);
	}
	.trades {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 8px;
	}
	.trades li {
		padding: 10px;
		border: 1px solid #ffffff14;
		border-radius: 4px;
		background: #ffffff06;
	}
	.trade-head {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		font: 11px var(--mono);
	}
	.status {
		color: var(--accent);
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.score {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font: 11px var(--mono);
	}
	.reveal {
		margin: 8px 0 0;
		font-size: 12.5px;
		overflow-wrap: anywhere;
	}
	.reveal a {
		color: var(--accent);
	}
</style>
