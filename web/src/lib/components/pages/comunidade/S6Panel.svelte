<!--
	Anonymous preference (opt-in). A blind, level-matched round between two selected strips (names
	hidden until the vote) produces A/B pairs that stay in this browser. Nothing leaves before the
	three explicit consents (LGPD art. 11), the Turnstile check and a click; the preview shows the
	EXACT JSON body that will be sent (no account, no IP in the batch). The receipt is a local secret:
	it is kept here and is the only way to withdraw the batch later.

	Silent consent (spec §4.1, L6, T10): the Turnstile module is imported and the widget mounted only
	after the three consents, so no third party is contacted and no check error can appear before the
	visitor asks to send.
-->
<script lang="ts">
	import { Explainer } from '#lib/components/comprehension/index.ts';
	import Button from '#lib/components/primitives/Button.svelte';
	import Panel from '#lib/components/primitives/Panel.svelte';
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

	type TurnstileComponent = typeof import('#lib/components/security/Turnstile.svelte').default;

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
	/** Why "Enviar" cannot act right now; null when it can (T8). */
	const sendReason = $derived(
		!consented
			? m.comunidade_s6_consent_required()
			: pairs.length === 0
				? m.comunidade_v2_reason_no_pairs()
				: !online
					? m.comunidade_offline()
					: token === '' || receipt === ''
						? m.comunidade_report_needs_check()
						: null
	);
	const roundPlaying = $derived(listener.owner === 's6');
	const startReason = $derived(
		!canListen
			? m.comunidade_audio_unavailable()
			: listener.busy
				? m.comunidade_v2_reason_busy()
				: null
	);

	// ---- Turnstile, on demand -----------------------------------------------------------------------

	let Turnstile = $state.raw<TurnstileComponent | null>(null);
	let turnstileFailed = $state(false);

	$effect(() => {
		if (!consented || !siteKey || Turnstile || turnstileFailed) return;
		let live = true;
		import('#lib/components/security/Turnstile.svelte')
			.then((module) => {
				if (live) Turnstile = module.default;
			})
			.catch((error: unknown) => {
				if (!live) return;
				turnstileFailed = true;
				console.warn(
					JSON.stringify({
						event: 'comunidade.turnstile_import_failed',
						error: error instanceof Error ? error.name : 'unknown'
					})
				);
			});
		return () => {
			live = false;
		};
	});

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

<svelte:head>
	{#if consented && siteKey}
		<!-- W7: the third party is warmed up only after the consent. -->
		<link rel="preconnect" href="https://challenges.cloudflare.com" />
	{/if}
</svelte:head>

<Panel
	variant="hardware"
	class="desk-panel"
	title={m.comunidade_s6_title()}
	data-testid="s6-panel"
	style="--panel-material: linear-gradient(180deg, #262a2e, #1a1c1f)"
>
	{#snippet explain()}<Explainer term="s6" />{/snippet}
	<p class="panel-lede">{m.comunidade_s6_lede()}</p>
	<div class="tb-grid">
		<div>
			<div class="round">
				<span class="fld-lbl">{m.comunidade_s6_round_title()}</span>
				{#if candidates.length < 2}
					<p class="note">{m.comunidade_s6_need_two()}</p>
				{:else if !round}
					<div>
						<Button disabledReason={startReason} onclick={startRound}
							>{m.comunidade_s6_round_start()}</Button
						>
					</div>
				{:else}
					<div class="xy" role="group" aria-label={m.comunidade_s6_round_title()}>
						<Button
							variant="key"
							size="sm"
							aria-pressed={listener.side === 'A'}
							lit={roundPlaying && listener.side === 'A'}
							disabledReason={roundPlaying ? null : m.comunidade_v2_reason_round()}
							onclick={() => listener.select('A')}>X</Button
						>
						<Button
							variant="key"
							size="sm"
							aria-pressed={listener.side === 'B'}
							lit={roundPlaying && listener.side === 'B'}
							disabledReason={roundPlaying ? null : m.comunidade_v2_reason_round()}
							onclick={() => listener.select('B')}>Y</Button
						>
					</div>
					<div class="row-btns">
						<Button onclick={() => vote('a')}>{m.comunidade_s6_prefer_x()}</Button>
						<Button onclick={() => vote('b')}>{m.comunidade_s6_prefer_y()}</Button>
						<Button variant="ghost" onclick={() => vote('tie')}>{m.comunidade_s6_tie()}</Button>
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
				<div class="check" data-testid="s6-check">
					{#if !consented}
						<p class="note">{m.comunidade_v2_turnstile_after_consent()}</p>
					{:else if !siteKey || turnstileFailed}
						<p class="note">{m.comunidade_turnstile_unavailable()}</p>
					{:else if Turnstile}
						<Turnstile {siteKey} action={TURNSTILE_S6_ACTION} bind:token />
					{:else}
						<div class="turnstile-wait" role="status" aria-busy="true">
							<span class="skeleton" aria-hidden="true"></span>
							<span>{m.comunidade_v2_turnstile_preparing()}</span>
						</div>
					{/if}
				</div>
				<div class="row-btns">
					<Button variant="primary" disabledReason={sendReason} loading={sending} onclick={send}
						>{m.comunidade_s6_send({ count: String(pairs.length) })}</Button
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
							<Button
								size="sm"
								disabledReason={online ? null : m.comunidade_offline()}
								onclick={() => withdraw(item)}>{m.comunidade_s6_withdraw()}</Button
							>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>
</Panel>

<style>
	.tb-grid {
		display: grid;
		grid-template-columns: 1fr 1.1fr;
		gap: var(--space-5);
	}
	.round {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin-bottom: var(--space-4);
	}
	.xy {
		display: inline-flex;
		gap: var(--space-1);
	}
	.consent {
		margin: 0;
		padding: var(--space-3);
		border: 1px solid var(--rule-control);
		border-radius: var(--rad-md);
	}
	.consent legend {
		color: var(--text);
		font: 500 var(--fs-small) / var(--lh-ui) var(--face-body);
	}
	.consent label {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		margin-bottom: 10px;
		color: var(--text-2);
		font-size: var(--fs-small);
		line-height: var(--lh-body);
	}
	.consent input[type='checkbox'] {
		flex: 0 0 auto;
		width: 16px;
		height: 16px;
		margin-top: 3px;
		accent-color: var(--accent);
	}
	.check {
		min-height: 65px;
	}
	.pairs-table {
		width: 100%;
		margin-bottom: 10px;
		border-collapse: collapse;
		font: 400 var(--fs-caption) var(--face-data);
	}
	.pairs-table th,
	.pairs-table td {
		padding: 6px var(--space-2);
		border-bottom: 1px solid var(--rule);
		text-align: left;
	}
	.receipts-title {
		margin-top: var(--space-3);
	}
	.receipts {
		display: grid;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
		font: var(--fs-caption) var(--face-body);
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
