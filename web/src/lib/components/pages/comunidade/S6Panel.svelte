<!--
	S6 · preference (opt-in, anonymous). A blind, level-matched round between two selected strips
	(names hidden until the vote) produces A/B pairs that stay in this browser. Nothing leaves before
	the three explicit consents (LGPD art. 11), the Turnstile check and a click; the preview shows the
	EXACT JSON body that will be sent (no account, no IP in the batch). The receipt is a local secret:
	it is kept here and is the only way to withdraw the batch later.
-->
<script lang="ts">
	import Turnstile from '#lib/components/security/Turnstile.svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import type { S6PairInput, SocialApi } from '#lib/social/index.ts';
	import type { Listener } from './listener.svelte.ts';
	import {
		S6_CONSENT_VERSION,
		TURNSTILE_S6_ACTION,
		errorText,
		formatDate,
		newReceipt,
		readReceipts,
		writeReceipts,
		type Channel,
		type ReceiptStorage,
		type StoredReceipt
	} from './model.ts';

	let {
		api,
		channels,
		listener,
		canListen,
		siteKey,
		online,
		storage,
		pairs = $bindable([]),
		token = $bindable(''),
		now = () => Date.now(),
		random = () => crypto.getRandomValues(new Uint32Array(1))[0] ?? 0,
		onnotice
	}: {
		api: SocialApi;
		/** Selected strips (the first two with a curve are compared). */
		channels: Channel[];
		listener: Listener;
		canListen: boolean;
		siteKey: string;
		online: boolean;
		storage: ReceiptStorage | null;
		pairs?: S6PairInput[];
		token?: string;
		now?: () => number;
		random?: () => number;
		onnotice: (message: string) => void;
	} = $props();

	const id = $props.id();
	let consentPairs = $state(false);
	let consentAnonymous = $state(false);
	let consentResearch = $state(false);
	/** Created in the browser only (never in the prerendered HTML). */
	let receipt = $state('');
	let receipts = $state.raw<StoredReceipt[]>([]);

	$effect(() => {
		if (receipt === '') receipt = newReceipt();
	});
	let sending = $state(false);
	let message = $state('');
	/** The running blind round: X and Y in random order. */
	let round = $state.raw<{ x: Channel; y: Channel } | null>(null);

	$effect(() => {
		receipts = readReceipts(storage);
	});

	const candidates = $derived(channels.filter((channel) => channel.curve !== null).slice(0, 2));
	const consented = $derived(consentPairs && consentAnonymous && consentResearch);
	const body = $derived({ consentVersion: S6_CONSENT_VERSION, receipt, pairs });
	const payload = $derived(JSON.stringify(body, null, 2));
	const canSend = $derived(
		consented && pairs.length > 0 && token !== '' && receipt !== '' && online && !sending
	);
	const roundPlaying = $derived(listener.owner === 's6');

	async function startRound() {
		const [first, second] = candidates;
		if (!first?.curve || !second?.curve) return;
		if (!canListen) {
			onnotice(m.comunidade_audio_unavailable());
			return;
		}
		const swap = random() % 2 === 1;
		const x = swap ? second : first;
		const y = swap ? first : second;
		if (!x.curve || !y.curve) return;
		try {
			await listener.play({
				a: { lineageId: x.lineageId, curve: x.curve },
				b: { lineageId: y.lineageId, curve: y.curve },
				initial: 'A',
				blind: true,
				owner: 's6'
			});
			round = { x, y };
		} catch (error) {
			onnotice(m.comunidade_audio_error());
			console.warn(
				JSON.stringify({
					event: 'comunidade.s6_round_failed',
					error: error instanceof Error ? error.name : 'unknown'
				})
			);
		}
	}

	function vote(choice: 'a' | 'b' | 'tie') {
		if (!round) return;
		pairs = [...pairs, { a: round.x.curveId, b: round.y.curveId, choice, levelMatched: true }];
		round = null;
		if (roundPlaying) listener.stop();
	}

	async function send() {
		if (!canSend) return;
		sending = true;
		message = '';
		const sent = { consentVersion: S6_CONSENT_VERSION, receipt, pairs: [...pairs] };
		try {
			await api.postS6Batch(sent, token);
			const stored: StoredReceipt = { receipt: sent.receipt, at: now(), pairs: sent.pairs.length };
			receipts = [...receipts, stored];
			message = writeReceipts(storage, receipts)
				? m.comunidade_s6_sent()
				: m.comunidade_s6_sent_unsaved({ receipt: sent.receipt });
			pairs = [];
			receipt = newReceipt();
		} catch (error) {
			message = errorText(error);
		} finally {
			token = '';
			sending = false;
		}
	}

	async function withdraw(item: StoredReceipt) {
		message = '';
		try {
			await api.deleteS6Batch(item.receipt);
			receipts = receipts.filter((entry) => entry.receipt !== item.receipt);
			writeReceipts(storage, receipts);
			message = m.comunidade_s6_withdrawn();
		} catch (error) {
			message = errorText(error);
		}
	}
</script>

<section class="talkback panel" aria-labelledby="{id}-title">
	<div class="sec-head">
		<h2 id="{id}-title">{m.comunidade_s6_title()}</h2>
		<p>{m.comunidade_s6_lede()}</p>
	</div>
	<div class="tb-grid">
		<div>
			<div class="round">
				<span class="fld-lbl">{m.comunidade_s6_round_title()}</span>
				{#if candidates.length < 2}
					<p class="note">{m.comunidade_s6_need_two()}</p>
				{:else if !round}
					<button type="button" class="btn" disabled={listener.busy} onclick={startRound}
						>{m.comunidade_s6_round_start()}</button
					>
				{:else}
					<div class="push-group" role="group" aria-label={m.comunidade_s6_round_title()}>
						<button
							type="button"
							class="push"
							aria-pressed={listener.side === 'A'}
							disabled={!roundPlaying}
							onclick={() => listener.select('A')}>X</button
						>
						<button
							type="button"
							class="push"
							aria-pressed={listener.side === 'B'}
							disabled={!roundPlaying}
							onclick={() => listener.select('B')}>Y</button
						>
					</div>
					<div class="row-btns">
						<button type="button" class="btn" onclick={() => vote('a')}
							>{m.comunidade_s6_prefer_x()}</button
						>
						<button type="button" class="btn" onclick={() => vote('b')}
							>{m.comunidade_s6_prefer_y()}</button
						>
						<button type="button" class="btn" onclick={() => vote('tie')}
							>{m.comunidade_s6_tie()}</button
						>
					</div>
				{/if}
			</div>
			<fieldset class="consent">
				<legend>{m.comunidade_s6_consent_legend()}</legend>
				<label>
					<input type="checkbox" bind:checked={consentPairs} />
					<span>{m.comunidade_s6_consent_pairs()}</span>
				</label>
				<label>
					<input type="checkbox" bind:checked={consentAnonymous} />
					<span>{m.comunidade_s6_consent_anonymous()}</span>
				</label>
				<label>
					<input type="checkbox" bind:checked={consentResearch} />
					<span>{m.comunidade_s6_consent_research()}</span>
				</label>
				{#if siteKey}
					<Turnstile {siteKey} action={TURNSTILE_S6_ACTION} bind:token />
				{:else}
					<p class="note">{m.comunidade_turnstile_unavailable()}</p>
				{/if}
				<div class="row-btns">
					<button type="button" class="btn primary" disabled={!canSend} onclick={send}
						>{m.comunidade_s6_send({ count: String(pairs.length) })}</button
					>
				</div>
				{#if !consented && pairs.length > 0}
					<p class="note">{m.comunidade_s6_consent_required()}</p>
				{/if}
				<p class="note" role="status">{message}</p>
			</fieldset>
		</div>
		<div>
			<span class="fld-lbl">{m.comunidade_s6_pairs()}</span>
			{#if pairs.length === 0}
				<p class="note">{m.comunidade_s6_no_pairs()}</p>
			{:else}
				<table class="pairs-table">
					<thead>
						<tr>
							<th scope="col">A</th>
							<th scope="col">B</th>
							<th scope="col">{m.comunidade_s6_choice()}</th>
						</tr>
					</thead>
					<tbody>
						{#each pairs as pair, index (index)}
							<tr><td>{pair.a}</td><td>{pair.b}</td><td>{pair.choice}</td></tr>
						{/each}
					</tbody>
				</table>
			{/if}
			<div class="out">
				<div class="out-head"><span>{m.comunidade_s6_payload()}</span></div>
				<pre data-testid="s6-payload">{payload}</pre>
			</div>
			<span class="fld-lbl receipts-title">{m.comunidade_s6_receipts()}</span>
			{#if receipts.length === 0}
				<p class="note">{m.comunidade_s6_no_receipts()}</p>
			{:else}
				<ul class="receipts">
					{#each receipts as item (item.receipt)}
						<li>
							<span
								>{formatDate(item.at, getLocale())} · {m.comunidade_s6_receipt_pairs({
									count: String(item.pairs)
								})}</span
							>
							<button type="button" class="btn" disabled={!online} onclick={() => withdraw(item)}
								>{m.comunidade_s6_withdraw()}</button
							>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>
</section>

<style>
	.talkback {
		background: linear-gradient(180deg, #262a2e, #1a1c1f);
	}
	.tb-grid {
		display: grid;
		grid-template-columns: 1fr 1.1fr;
		gap: 20px;
	}
	.round {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-bottom: 14px;
	}
	.consent label {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		font-size: 12.5px;
		line-height: 1.55;
		color: #e1dcd1;
		margin-bottom: 10px;
	}
	.consent input[type='checkbox'] {
		accent-color: var(--accent);
		margin-top: 4px;
		width: 15px;
		height: 15px;
		flex: 0 0 auto;
	}
	.pairs-table {
		width: 100%;
		border-collapse: collapse;
		font: 11px var(--mono);
		margin-bottom: 10px;
	}
	.pairs-table th,
	.pairs-table td {
		padding: 6px 8px;
		border-bottom: 1px solid #ffffff12;
		text-align: left;
	}
	.receipts-title {
		margin-top: 12px;
	}
	.receipts {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 6px;
		font: 11px var(--mono);
	}
	.receipts li {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 10px;
	}
	@media (max-width: 1000px) {
		.tb-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
