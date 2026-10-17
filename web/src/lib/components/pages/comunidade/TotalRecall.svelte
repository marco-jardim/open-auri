<!--
	Total Recall (owner only): the version log of one of your lineages (`GET /lineages/[id]`), the
	diff between two versions (band table and response delta, core math) and "restaurar", which
	publishes a NEW version copied from an old one (append with parentVersionId = the head you saw).
	A concurrent change answers HEAD_MOVED: the page says so and offers to reload, never retries
	silently. Versions are append-only: nothing is rewritten.
-->
<script lang="ts">
	import { Button } from '#lib/components/primitives/index.ts';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { m } from '#lib/paraglide/messages.js';
	import {
		isSocialApiError,
		type LineageVersions,
		type PublishedCurve,
		type SocialApi
	} from '#lib/social/index.ts';
	import { createKeyedStore } from './keyed.ts';
	import {
		bandRows,
		bandText,
		buildEnvelope,
		curveCodesOf,
		decodeCurve,
		deltaPath,
		envelopeIssueText,
		errorText,
		formatDate,
		formatDb,
		formatHz,
		gateReasonText,
		gateReasonsOf,
		responseDelta,
		type DecodedCurve,
		type Lang
	} from './model.ts';

	type Version = LineageVersions['versions'][number];

	/** Skeleton lines of the version log while it loads (spec §5.5). */
	const SKELETON_ROWS = [1, 2, 3, 4] as const;

	let {
		api,
		owned,
		preferred = null,
		canWrite,
		online,
		now = () => Date.now(),
		onrestored
	}: {
		api: SocialApi;
		owned: { id: string; name: string }[];
		preferred?: string | null;
		canWrite: boolean;
		online: boolean;
		now?: () => number;
		onrestored?: () => void;
	} = $props();

	const id = $props.id();
	let lineageId = $state('');
	let data = $state.raw<LineageVersions | null>(null);
	let loading = $state(false);
	let loadError = $state('');
	let fromId = $state('');
	let toId = $state('');
	let curves = $state.raw<Record<string, { curve: DecodedCurve | null; full: PublishedCurve }>>({});
	let restoring = $state(false);
	let headMoved = $state(false);
	let message = $state('');
	let reasons = $state.raw<string[]>([]);
	let codes = $state.raw<string[]>([]);

	$effect(() => {
		const wanted = preferred && owned.some((item) => item.id === preferred) ? preferred : null;
		if (wanted && wanted !== lineageId) lineageId = wanted;
		else if (!lineageId && owned[0]) lineageId = owned[0].id;
	});

	$effect(() => {
		const current = lineageId;
		if (!current || !online) return;
		void load(current);
	});

	async function load(target: string) {
		loading = true;
		loadError = '';
		headMoved = false;
		try {
			const result = await api.getLineage(target, { limit: 50 });
			if (target !== lineageId) return;
			data = result;
			const head = result.versions.find((version) => version.isHead) ?? result.versions[0];
			toId = head?.id ?? '';
			fromId = head?.parentId ?? result.versions.find((version) => !version.isHead)?.id ?? '';
		} catch (error) {
			data = null;
			loadError = errorText(error);
		} finally {
			loading = false;
		}
	}

	/** Requests in flight (plain bookkeeping, never rendered: it only deduplicates). */
	type CurveEntry = { curve: DecodedCurve | null; full: PublishedCurve };
	const pending = createKeyedStore<Promise<CurveEntry>>();

	async function curveOf(versionId: string) {
		const cached = curves[versionId];
		if (cached) return cached;
		const inflight = pending.get(versionId);
		if (inflight) return inflight;
		const request = api
			.getCurve(lineageId, { versionId })
			.then((full) => {
				const entry = { curve: decodeCurve(full.curve.s1), full };
				curves = { ...curves, [versionId]: entry };
				return entry;
			})
			.finally(() => pending.delete(versionId));
		pending.set(versionId, request);
		return request;
	}

	$effect(() => {
		const wanted = [fromId, toId].filter((value) => value !== '');
		for (const versionId of wanted) {
			if (curves[versionId] || pending.has(versionId)) continue;
			curveOf(versionId).catch((error: unknown) => {
				loadError = errorText(error);
			});
		}
	});

	const fromCurve = $derived(curves[fromId]?.curve ?? null);
	const toCurve = $derived(curves[toId]?.curve ?? null);
	const rows = $derived(fromCurve && toCurve ? bandRows(fromCurve, toCurve) : []);
	const delta = $derived(fromCurve && toCurve ? responseDelta(fromCurve, toCurve) : null);
	const path = $derived(fromCurve && toCurve ? deltaPath(fromCurve, toCurve) : '');
	const headId = $derived(data?.lineage.headVersion ?? null);
	const versions = $derived(data?.versions ?? []);
	const restorable = $derived(
		versions.find((version) => version.id === fromId && !version.isHead) ?? null
	);
	/** Why "Restaurar" cannot act right now; null when it can (T8). */
	const restoreReason = $derived(
		!canWrite ? m.comunidade_verify_prompt() : !online ? m.comunidade_offline() : null
	);

	function label(version: Version): string {
		return `${version.id.slice(0, 7)} · ${version.name}`;
	}

	function isLang(value: string): value is Lang {
		return value === 'pt-BR' || value === 'en-US';
	}

	async function restore(version: Version) {
		if (!canWrite || !headId || restoring) return;
		restoring = true;
		message = '';
		reasons = [];
		codes = [];
		headMoved = false;
		try {
			const source = await curveOf(version.id);
			const built = buildEnvelope({
				name: version.name,
				description: version.description,
				license: version.license,
				lang: isLang(version.lang) ? version.lang : 'pt-BR',
				s1: source.full.curve.s1,
				recipe: source.full.version.recipe,
				now: now()
			});
			if (!built.ok) {
				message = built.codes.map(envelopeIssueText).join(' ');
				return;
			}
			await api.appendVersion(lineageId, { parentVersionId: headId, envelope: built.envelope });
			message = m.comunidade_recall_restored({ version: version.id.slice(0, 7) });
			onrestored?.();
			await load(lineageId);
		} catch (error) {
			if (isSocialApiError(error)) {
				if (error.code === 'HEAD_MOVED') headMoved = true;
				else if (error.code === 'GATE_REJECTED') reasons = gateReasonsOf(error);
				else if (error.code === 'INVALID_CURVE') codes = curveCodesOf(error);
			}
			message = errorText(error);
		} finally {
			restoring = false;
		}
	}
</script>

<div class="recall-panel">
	<div class="panel-head">
		<h2 id="{id}-title">{m.comunidade_recall_title()}</h2>
		<span class="plate">{m.comunidade_recall_plate()}</span>
	</div>
	<div class="monitor">
		<div class="screen" data-testid="total-recall">
			{#if owned.length === 0}
				<p class="scr-line">{m.comunidade_recall_none()}</p>
			{:else}
				<label class="scr-head">
					<span>{m.comunidade_recall_lineage()}</span>
					<select bind:value={lineageId}>
						{#each owned as item (item.id)}
							<option value={item.id}>{item.name}</option>
						{/each}
					</select>
				</label>
				{#if !online}
					<p class="scr-line">{m.comunidade_offline()}</p>
				{:else if loading && !data}
					<div class="skel-rows" role="status" aria-busy="true" data-testid="recall-loading">
						<span class="sr-only">{m.comunidade_loading()}</span>
						{#each SKELETON_ROWS as row (row)}
							<span class="skeleton skel-row" aria-hidden="true"></span>
						{/each}
					</div>
				{:else if loadError}
					<p class="scr-line bad" role="alert">{loadError}</p>
				{/if}
				{#if data}
					<ol class="commits" aria-label={m.comunidade_recall_versions()}>
						{#each versions as version (version.id)}
							<li class="commit" class:head={version.isHead}>
								<span class="hash">{version.id.slice(0, 7)}</span>
								<span class="date">{formatDate(version.createdAt, getLocale())}</span>
								<span class="msg">{version.name}</span>
								<span class="st">{version.isHead ? 'HEAD' : version.license}</span>
							</li>
						{/each}
					</ol>
					<div class="pick">
						<label>
							<span>{m.comunidade_recall_from()}</span>
							<select bind:value={fromId}>
								{#each versions as version (version.id)}
									<option value={version.id}>{label(version)}</option>
								{/each}
							</select>
						</label>
						<label>
							<span>{m.comunidade_recall_to()}</span>
							<select bind:value={toId}>
								{#each versions as version (version.id)}
									<option value={version.id}>{label(version)}</option>
								{/each}
							</select>
						</label>
					</div>
					{#if rows.length > 0}
						<table class="bands">
							<caption>{m.comunidade_recall_diff_caption()}</caption>
							<thead>
								<tr>
									<th scope="col">#</th>
									<th scope="col">{m.comunidade_recall_from()}</th>
									<th scope="col">{m.comunidade_recall_to()}</th>
								</tr>
							</thead>
							<tbody>
								{#each rows as row (row.index)}
									<tr class:changed={row.changed}>
										<th scope="row"
											>{m.comunidade_v2_recall_filter({ n: String(row.index + 1) })}</th
										>
										<td>{bandText(row.a)}</td>
										<td>{bandText(row.b)}{row.changed ? ' *' : ''}</td>
									</tr>
								{/each}
							</tbody>
						</table>
						<div class="delta">
							<svg viewBox="0 0 420 110" role="img" aria-label={m.comunidade_recall_delta_label()}>
								<line x1="4" x2="416" y1="55" y2="55" class="zero" />
								<path d={path} class="trace" />
							</svg>
							{#if delta}
								<p class="delta-read">
									{m.comunidade_recall_delta({
										rms: formatDb(delta.rmsDb),
										max: formatDb(delta.maxDb),
										freq: formatHz(delta.maxFreqHz)
									})}
								</p>
							{/if}
						</div>
					{/if}
					{#if restorable}
						<Button
							class="restore"
							disabledReason={restoreReason}
							loading={restoring}
							onclick={() => restore(restorable)}
							>{m.comunidade_recall_restore({ version: restorable.id.slice(0, 7) })}</Button
						>
						<p class="scr-note">{m.comunidade_recall_restore_note()}</p>
					{/if}
					{#if headMoved}
						<div class="conflict" role="alert" data-testid="recall-conflict">
							<p>{m.comunidade_recall_head_moved()}</p>
							<Button class="restore" onclick={() => load(lineageId)}
								>{m.comunidade_recall_reload()}</Button
							>
						</div>
					{:else if message}
						<p class="scr-line" role="status">{message}</p>
					{/if}
					{#if reasons.length > 0}
						<ul class="reasons">
							{#each reasons as code (code)}<li>{gateReasonText(code)}</li>{/each}
						</ul>
					{/if}
					{#if codes.length > 0}
						<ul class="reasons">
							{#each codes as code (code)}<li>{envelopeIssueText(code)}</li>{/each}
						</ul>
					{/if}
				{/if}
			{/if}
		</div>
		<div class="monitor-foot"><span>RECALL DISPLAY · 80×25</span><span class="vent"></span></div>
	</div>
</div>

<style>
	.panel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 10px;
	}
	.panel-head h2 {
		font: italic 400 var(--fs-title) / var(--lh-title) var(--face-display);
		letter-spacing: var(--tracking-title);
		margin: 0;
	}
	.plate {
		font: 500 var(--fs-eyebrow) var(--face-data);
		letter-spacing: var(--tracking-caps);
		color: #d6d2c8;
		padding: 4px 9px;
		border: 1px solid #000;
		background: #1c1e20;
	}
	.monitor {
		background: linear-gradient(160deg, #d6ccb5, #b3a88f 60%, #9c917a);
		border-radius: 14px 14px 10px 10px;
		padding: 16px 16px 10px;
		box-shadow:
			inset 0 2px 0 #fffbe9aa,
			inset 0 -3px 0 #6d6553,
			0 18px 30px #000c;
	}
	.screen {
		position: relative;
		border-radius: 10px;
		padding: 14px;
		min-height: 420px;
		background: radial-gradient(130% 100% at 50% 40%, #16120a, #070604 85%);
		box-shadow:
			inset 0 0 40px #000,
			inset 0 0 0 3px #2a2418;
		font-family: var(--crt);
		color: var(--amber);
		overflow: auto;
	}
	.scr-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		font-size: var(--fs-readout-l);
		border-bottom: 1px dashed #ffb54755;
		padding-bottom: 6px;
		margin-bottom: 8px;
	}
	select {
		background: #0a0805;
		color: var(--amber);
		border: 1px solid #ffb54788;
		font: var(--fs-lede) var(--crt);
		max-width: 100%;
		min-height: 28px;
	}
	.scr-line,
	.scr-note {
		margin: 6px 0;
		font-size: var(--fs-lede);
		line-height: 1.2;
	}
	.scr-note {
		font-size: var(--fs-body);
		color: #d39a46;
	}
	.bad {
		color: #ff9fa2;
	}
	/* Not a scroll box: its items are not focusable, so it grows instead (the screen scrolls and
	   contains focusable selects). */
	.commits {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.commit {
		display: grid;
		grid-template-columns: 70px 130px 1fr auto;
		gap: 8px;
		font: var(--fs-lede) / 1.15 var(--crt);
		padding: 3px 4px;
	}
	.commit.head {
		background: #ffb5472b;
	}
	.msg {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.st {
		color: #d39a46;
	}
	.pick {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		margin: 8px 0;
		font-size: var(--fs-lede);
	}
	.pick label {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.bands {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--fs-body);
	}
	.bands caption {
		text-align: left;
		color: #ffd08a;
		font-size: var(--fs-lede);
	}
	.bands th,
	.bands td {
		text-align: left;
		padding: 1px 4px;
		border-bottom: 1px solid #ffb5471a;
	}
	.bands tr.changed td {
		color: #ffd08a;
	}
	.delta {
		display: grid;
		grid-template-columns: 1fr 150px;
		gap: 10px;
		align-items: center;
		margin-top: 10px;
		border-top: 1px dashed #ffb54755;
		padding-top: 8px;
	}
	.delta svg {
		width: 100%;
		height: auto;
	}
	.zero {
		stroke: #ffb54755;
	}
	.trace {
		fill: none;
		stroke: var(--amber);
		stroke-width: 1.5;
	}
	.delta-read {
		margin: 0;
		font-size: var(--fs-body);
		line-height: 1.2;
	}
	/* The Button primitive dressed for the amber CRT (behaviour and reasons from the primitive). */
	.recall-panel :global(.restore) {
		margin-top: 10px;
		min-height: var(--hit);
		padding: 6px 12px;
		border: 1px solid var(--amber);
		border-radius: var(--rad-xs);
		background: #1a1208;
		color: var(--amber);
		font: var(--fs-lede) / 1 var(--crt);
		letter-spacing: 0;
	}
	.skel-rows {
		display: grid;
		gap: 6px;
		margin-top: var(--space-2);
	}
	/* One commit line of the log (VT323 at the lede size). */
	.skel-row {
		height: 20px;
	}
	.conflict {
		margin-top: 10px;
		padding: 8px 10px;
		border-left: 3px solid var(--danger);
		background: #e5484d1a;
		color: #ffb3b5;
		font-size: var(--fs-lede);
	}
	.conflict p {
		margin: 0;
	}
	.reasons {
		margin: 6px 0 0;
		padding-left: 18px;
		color: #ff9fa2;
		font-size: var(--fs-body);
	}
	.monitor-foot {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-top: 9px;
		font: 500 var(--label-min) var(--face-data);
		letter-spacing: var(--tracking-caps);
		color: #3a3427;
	}
	.vent {
		width: 90px;
		height: 8px;
		background: repeating-linear-gradient(90deg, #6d6553 0 3px, transparent 3px 6px);
		border-radius: 2px;
	}
	@media (max-width: 640px) {
		.commit {
			grid-template-columns: 64px 1fr auto;
		}
		.commit .date {
			display: none;
		}
		.delta {
			grid-template-columns: 1fr;
		}
	}
</style>
