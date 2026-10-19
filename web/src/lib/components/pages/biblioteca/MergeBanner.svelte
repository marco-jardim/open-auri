<script lang="ts">
	// Offer to merge the anonymous browser library into the account (T4.14). Never automatic: the
	// banner appears after sign-in while local items are not merged, and only a click sends them,
	// in batches of at most 20, continuing quota retries while they make progress. Rejected items
	// stay local only. The flag is kept per account.
	import { m } from '#lib/paraglide/messages.js';
	import type { MergeReport, SocialApi } from '#lib/social/index.ts';
	import { createClassifier } from '#lib/workers/classifier.svelte.ts';
	import {
		readMergeFlag,
		runMerge,
		toMergeItem,
		unmergedItems,
		writeMergeFlag,
		type KeyValueStorage,
		type LocalLibraryItem,
		type MergeOutcome
	} from './social.ts';

	let {
		items,
		account,
		verified,
		api,
		storage,
		locale,
		now = Date.now,
		onMerged
	}: {
		items: readonly LocalLibraryItem[];
		account: string;
		verified: boolean;
		api: Pick<SocialApi, 'mergeLibrary'>;
		storage: KeyValueStorage | null;
		locale: string;
		now?: () => number;
		onMerged?: (report: MergeReport) => void;
	} = $props();
	const id = $props.id();

	let flagVersion = $state(0);
	const flag = $derived.by(() => {
		void flagVersion;
		return readMergeFlag(storage, account);
	});
	const pending = $derived(unmergedItems(items, flag));
	let running = $state(false);
	let progress = $state({ done: 0, total: 0 });
	let outcome = $state.raw<MergeOutcome | null>(null);
	const names = $derived(new Map(items.map((item) => [item.id, item.name])));

	type ConflictField = MergeReport['conflicts'][number]['field'];
	/** What differs from the account's copy: the name, the filter labels, or both. */
	function conflictText(fields: readonly ConflictField[]): string {
		const name = fields.includes('name');
		const labels = fields.includes('labels');
		if (name && labels) return m.biblioteca_social_merge_conflict_both();
		return labels
			? m.biblioteca_social_merge_conflict_labels()
			: m.biblioteca_social_merge_conflict_name();
	}
	/** One row per item, with every field that differs (the report has one entry per field). */
	function conflictRows(report: MergeReport): { localId: string; fields: ConflictField[] }[] {
		const rows: { localId: string; fields: ConflictField[] }[] = [];
		for (const entry of report.conflicts) {
			let row = rows.find((candidate) => candidate.localId === entry.localId);
			if (!row) rows.push((row = { localId: entry.localId, fields: [] }));
			if (!row.fields.includes(entry.field)) row.fields.push(entry.field);
		}
		return rows;
	}

	const reasonLabels: Record<MergeReport['rejected'][number]['code'], () => string> = {
		INVALID_CURVE: () => m.biblioteca_social_reject_invalid_curve(),
		GATE_REJECTED: () => m.biblioteca_social_reject_gate(),
		INVALID_TEXT: () => m.biblioteca_social_reject_text(),
		QUOTA_EXCEEDED: () => m.biblioteca_social_reject_quota(),
		DUPLICATE: () => m.biblioteca_social_reject_duplicate(),
		INTERNAL: () => m.biblioteca_social_reject_internal()
	};

	function dismiss() {
		const current = readMergeFlag(storage, account);
		writeMergeFlag(storage, account, { ...current, offeredAt: now() });
		flagVersion += 1;
	}

	async function merge() {
		if (running || !verified || pending.length === 0) return;
		running = true;
		outcome = null;
		const batch = pending.map((item) => toMergeItem(item, locale));
		progress = { done: 0, total: batch.length };
		// The gate weights (a YOLO item costs 2 runs) are classified in a worker of their own, one
		// item at a time, so a long library never blocks the page.
		const classifier = createClassifier();
		try {
			const result = await runMerge(
				api,
				batch,
				(done, total) => {
					progress = { done, total };
				},
				{ classify: (curve, signal) => classifier.classify(curve, signal) }
			);
			const current = readMergeFlag(storage, account);
			writeMergeFlag(storage, account, {
				offeredAt: current.offeredAt,
				handled: [...new Set([...current.handled, ...result.handled])]
			});
			flagVersion += 1;
			outcome = result;
			if (result.report.created.length + result.report.duplicates.length > 0) {
				onMerged?.(result.report);
			}
		} finally {
			classifier.dispose();
			running = false;
		}
	}
</script>

{#if outcome}
	{@const report = outcome.report}
	{@const conflicts = conflictRows(report)}
	<section class="merge report" aria-labelledby="{id}-report">
		<h3 id="{id}-report">{m.biblioteca_social_merge_report()}</h3>
		<ul>
			<li>{m.biblioteca_social_merge_created({ count: report.created.length })}</li>
			<li>{m.biblioteca_social_merge_duplicates({ count: report.duplicates.length })}</li>
			<li>{m.biblioteca_social_merge_conflicts_any({ count: conflicts.length })}</li>
			<li>{m.biblioteca_social_merge_rejected({ count: report.rejected.length })}</li>
		</ul>
		{#if conflicts.length > 0}
			<ul class="conflicts">
				{#each conflicts as entry (entry.localId)}
					<li>
						<strong>{names.get(entry.localId) ?? entry.localId}</strong>:
						{conflictText(entry.fields)}
					</li>
				{/each}
			</ul>
		{/if}
		{#if report.rejected.length > 0}
			<ul class="rejected">
				{#each report.rejected as entry (entry.localId)}
					<li>
						<strong>{names.get(entry.localId) ?? entry.localId}</strong>:
						{reasonLabels[entry.code]()}{#if entry.reasons && entry.reasons.length > 0}<span
								class="reasons"
								>{m.biblioteca_social_merge_reasons({ reasons: entry.reasons.join(', ') })}</span
							>{/if}
					</li>
				{/each}
			</ul>
		{/if}
		{#if outcome.error}<p role="alert">
				{outcome.error === 'OFFLINE' || outcome.error === 'NETWORK'
					? m.biblioteca_social_offline()
					: outcome.error === 'EMAIL_NOT_VERIFIED'
						? m.biblioteca_social_merge_verify()
						: m.biblioteca_social_merge_stopped({ count: outcome.unsent })}
			</p>{/if}
		<button
			type="button"
			onclick={() => {
				outcome = null;
			}}>{m.biblioteca_social_merge_close()}</button
		>
	</section>
{:else if pending.length > 0}
	<section class="merge" aria-labelledby="{id}-title">
		<h3 id="{id}-title">{m.biblioteca_social_merge_title()}</h3>
		<p>{m.biblioteca_social_merge_note({ count: pending.length })}</p>
		{#if !verified}<p>{m.biblioteca_social_merge_verify()}</p>{/if}
		{#if running}<p role="status">
				{m.biblioteca_social_merge_running({ done: progress.done, total: progress.total })}
			</p>{/if}
		<div class="actions">
			<button type="button" disabled={!verified || running} onclick={merge}
				>{m.biblioteca_social_merge_action()}</button
			>
			<button type="button" disabled={running} onclick={dismiss}
				>{m.biblioteca_social_merge_later()}</button
			>
		</div>
	</section>
{/if}

<style>
	.merge {
		margin: 0 0 18px;
		padding: 16px 18px;
		color: #302c23;
		background: repeating-linear-gradient(0deg, transparent 0 24px, #75633e2b 25px 26px), #e1d6b9;
		box-shadow: 1px 3px 4px #0006;
		font:
			12px/1.6 'Courier Prime',
			monospace;
	}
	h3 {
		margin: 0 0 6px;
		font:
			700 18px 'Courier Prime',
			monospace;
	}
	p,
	ul {
		margin: 4px 0;
	}
	ul {
		padding-left: 18px;
	}
	.reasons {
		display: block;
		font-size: 11px;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		margin-top: 10px;
	}
	button {
		min-height: 36px;
		padding: 8px 12px;
		border: 1px solid #5e523d;
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
	button:focus-visible {
		outline: 3px solid #f6bd55;
		outline-offset: 4px;
	}
</style>
