<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import Turnstile from '#lib/components/security/Turnstile.svelte';
	import { isSocialApiError, type SocialApi } from '#lib/social/index.ts';
	import type { Session } from './experiment.ts';
	import {
		S6_CONSENT_VERSION,
		S6_TURNSTILE_ACTION,
		addReceipt,
		buildBatch,
		buildPairs,
		defaultReceiptStorage,
		newReceipt,
		readReceipts,
		removeReceipt,
		s6Day,
		type ReceiptStorage,
		type S6Pair,
		type S6Receipt
	} from './s6.ts';

	let {
		session = null,
		api = null,
		siteKey = '',
		storage,
		token = $bindable('')
	}: {
		/** The finished session (null while listening: nothing is previewed mid-test). */
		session?: Session | null;
		api?: Pick<SocialApi, 'postS6Batch' | 'deleteS6Batch'> | null;
		siteKey?: string;
		/** Receipt storage (default: localStorage; null disables the local list). */
		storage?: ReceiptStorage | null;
		/** Turnstile token, filled by the widget (single use: cleared after each attempt). */
		token?: string;
	} = $props();

	const uid = $props.id();
	const store = $derived(storage === undefined ? defaultReceiptStorage() : storage);
	let consentData = $state(false);
	let consentWithdraw = $state(false);
	let pairs = $state.raw<S6Pair[]>([]);
	let receipt = $state(newReceipt());
	let attempt = $state(0);
	let busy = $state(false);
	let message = $state('');
	let receipts = $state.raw<S6Receipt[]>([]);
	const consented = $derived(consentData && consentWithdraw);
	const batch = $derived(buildBatch(receipt, pairs));
	const payload = $derived(JSON.stringify(batch, null, 2));
	const canSend = $derived(consented && api !== null && token !== '' && pairs.length > 0 && !busy);

	$effect(() => {
		receipts = store ? readReceipts(store) : [];
	});
	$effect(() => {
		const current = session;
		let cancelled = false;
		buildPairs(current).then(
			(value) => {
				if (!cancelled) pairs = value;
			},
			(error: unknown) => {
				console.warn(JSON.stringify({ event: 's6.pairs', error: (error as Error).name }));
				if (!cancelled) pairs = [];
			}
		);
		return () => {
			cancelled = true;
		};
	});

	async function send() {
		if (!canSend || api === null) return;
		const body = batch;
		const used = token;
		busy = true;
		message = m.cegos6_sending();
		// Stored first: if the answer is lost after the server kept the batch, it can still be withdrawn.
		const record = { receipt: body.receipt, day: s6Day(), pairs: body.pairs.length };
		if (store) receipts = addReceipt(store, record);
		try {
			await api.postS6Batch(body, used);
			message = m.cegos6_sent();
			receipt = newReceipt();
			consentData = false;
			consentWithdraw = false;
		} catch (error) {
			if (!isSocialApiError(error)) {
				message = m.cegos6_failed();
				console.warn(JSON.stringify({ event: 's6.send', error: (error as Error).name }));
			} else if (error.unreachable) {
				message = m.cegos6_offline();
			} else if (error.code === 'DUPLICATE') {
				message = m.cegos6_sent();
				receipt = newReceipt();
			} else {
				if (store) receipts = removeReceipt(store, body.receipt);
				message = m.cegos6_failed();
				receipt = newReceipt();
			}
		} finally {
			busy = false;
			token = '';
			attempt += 1;
		}
	}

	async function withdraw(record: S6Receipt) {
		if (api === null || busy) return;
		busy = true;
		try {
			await api.deleteS6Batch(record.receipt);
			if (store) receipts = removeReceipt(store, record.receipt);
			message = m.cegos6_deleted();
		} catch (error) {
			if (!isSocialApiError(error)) {
				console.warn(JSON.stringify({ event: 's6.delete', error: (error as Error).name }));
			}
			message = m.cegos6_delete_failed();
		} finally {
			busy = false;
		}
	}
</script>

<div class="s6">
	<div class="card">
		<label class="opt"
			><input type="checkbox" bind:checked={consentData} /><span>{m.cego_consent_data()}</span
			></label
		><label class="opt"
			><input type="checkbox" bind:checked={consentWithdraw} /><span
				>{m.cego_consent_withdraw()}</span
			></label
		>
		<p class="note">{m.cego_private()}</p>
		<p class="note">{m.cegos6_consent_version({ version: S6_CONSENT_VERSION })}</p>
		{#if api && siteKey && consented && pairs.length > 0}
			{#key attempt}
				<Turnstile {siteKey} action={S6_TURNSTILE_ACTION} bind:token label={m.cegos6_turnstile()} />
			{/key}
		{/if}
		<button
			class="accent"
			type="button"
			disabled={!canSend}
			aria-describedby="{uid}-send-note"
			onclick={send}>{m.cego_send()}</button
		>
		<p id="{uid}-send-note" class="note">
			{api === null
				? m.cegos6_unavailable()
				: pairs.length === 0
					? m.cegos6_no_pairs()
					: m.cegos6_ready_note()}
		</p>
		<p class="message" role="status">{message}</p>
	</div>
	<h3>{m.cego_preview()}</h3>
	<p class="note">{m.cegos6_preview_note()}</p>
	<textarea
		class="payload"
		readonly
		rows="12"
		wrap="off"
		aria-label={m.cego_preview()}
		value={payload}></textarea>
	<h3>{m.cegos6_receipts()}</h3>
	{#if receipts.length > 0}
		<ul class="receipts">
			{#each receipts as record (record.receipt)}
				<li>
					<span class="mono">{record.receipt.slice(0, 8)}…</span>
					<span>{m.cegos6_receipt_item({ day: record.day, count: record.pairs })}</span>
					<button
						type="button"
						disabled={api === null || busy}
						aria-label={m.cegos6_delete_label({ id: record.receipt.slice(0, 8) })}
						onclick={() => withdraw(record)}>{m.cegos6_delete()}</button
					>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="note">{m.cegos6_no_receipts()}</p>
	{/if}
</div>

<style>
	.card {
		border: 1px solid #ece7dd24;
		border-radius: 12px;
		padding: 16px;
		background: #ffffff04;
		margin: 0 0 14px;
	}
	.opt {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		padding: 10px 0;
		font-size: 13px;
	}
	.note {
		font-size: 12px;
		color: #b5ad9f;
		margin: 10px 0 0;
	}
	.message {
		min-height: 1.5em;
		color: #e8d3a6;
		font-size: 13px;
	}
	button {
		font: inherit;
		border: 1px solid #ece7dd24;
		border-radius: 6px;
		background: transparent;
		color: inherit;
		padding: 7px 12px;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.accent {
		background: #ffd27a;
		color: #1d1606;
		border-color: #ffd27a;
		font-weight: 600;
		margin-top: 10px;
	}
	h3 {
		font-size: 13px;
		font-weight: 600;
		margin: 14px 0 6px;
	}
	.payload {
		width: 100%;
		max-height: 300px;
		overflow: auto;
		font: 11px/1.5 var(--mono, monospace);
		color: #ece7dd;
		background: #0b0a09;
		border: 1px solid #ece7dd24;
		border-radius: 10px;
		padding: 12px;
	}
	.receipts {
		list-style: none;
		padding: 0;
		display: grid;
		gap: 8px;
		font-size: 12px;
	}
	.receipts li {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		align-items: center;
	}
	.mono {
		font-family: var(--mono, monospace);
	}
</style>
