<script lang="ts">
	import { onMount } from 'svelte';
	import { EnvelopeError, S1Error } from 'open-auri/share';
	import type { ClientApp } from '#lib/app/index.ts';
	import { sameLabels } from '#lib/state/model.ts';
	import {
		createSocialOutbox,
		createSocialSession,
		isSocialApiError,
		originOf,
		rememberOrigin,
		requireLoginHref,
		type CurveOrigin,
		type SocialApi,
		type SocialSession
	} from '#lib/social/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { Button, Panel } from '#lib/components/primitives/index.ts';
	import type { Curve } from './model.ts';
	import type { UrlLike } from './layers.ts';
	import type { CurvaPreview } from './preview.svelte.ts';
	import { exitRefusal, exitRefusalText } from './yolo.ts';
	import {
		checkEnvelope,
		currentS1,
		curvaSocialApi,
		PreviewActivity,
		serverGateMessages,
		socialEnvelope,
		textIssueText,
		type TextIssue
	} from './social.ts';

	interface Props {
		app: ClientApp | null;
		curve: Curve;
		name: string;
		locale: string;
		pageUrl: UrlLike;
		preview?: CurvaPreview | null;
		originHint?: { s1: string; lineageId: string; versionId: string } | null;
		api?: SocialApi;
		session?: SocialSession;
		clipboard?: (text: string) => Promise<void>;
		/**
		 * Why the curve may not be saved to the account, published or shared: the standard gate
		 * refuses it (a YOLO-only curve restored after a reload). `submit` re-gates the draft too.
		 */
		blockedReason?: string | null;
	}
	let {
		app,
		curve,
		name,
		locale,
		pageUrl,
		preview = null,
		originHint = null,
		blockedReason = null,
		api = curvaSocialApi(),
		session = createSocialSession({ fetch: fetchSession }),
		clipboard = (text) => navigator.clipboard.writeText(text)
	}: Props = $props();

	const headingId = $props.id();
	const s1 = $derived(currentS1(curve));
	let found = $state.raw<{ s1: string; value: CurveOrigin } | null>(null);
	const origin = $derived(found && found.s1 === s1 ? found.value : null);
	let originRevision = $state(0);
	let reconnectRevision = $state(0);
	let offline = $state(false);
	let busy = $state(false);
	let message = $state('');
	let gateMessages = $state<string[]>([]);
	let favorites = $state<Record<string, boolean>>({});
	let favoriteLoading = $state(false);
	let shared = $state.raw<{ s1: string; url: string } | null>(null);
	const link = $derived(shared && shared.s1 === s1 ? shared.url : '');
	const unavailable = $derived(!app || !s1 || offline || busy || !session.verified);
	/** Why the account actions are unavailable, in the order a person can fix it (T8). */
	const reason = $derived(
		!app
			? m.curva_v2_loading_reason()
			: !session.signedIn
				? m.curva_v2_social_login_reason()
				: !session.verified
					? m.curva_v2_social_verify_reason()
					: offline
						? m.curva_v2_social_offline_reason()
						: busy
							? m.curva_v2_social_busy_reason()
							: !s1
								? m.curva_v2_social_code_reason()
								: null
	);
	/** Save, publish and share: the account reason first, then the standard gate's refusal. */
	const exitReason = $derived(reason ?? blockedReason);
	const loginHref = $derived(
		requireLoginHref(new URL(pageUrl.href).pathname + new URL(pageUrl.href).search)
	);
	const outbox = $derived(app ? createSocialOutbox({ store: app.state.outbox, session }) : null);
	const activity = new PreviewActivity();
	let dialog = $state<HTMLDialogElement | null>(null);
	let dialogOpen = $state(false);
	/** "Salvar" asks for the text of a private copy; "Publicar" also picks license and visibility. */
	let mode = $state<'publish' | 'save'>('publish');
	let nameField = $state<HTMLInputElement | null>(null);
	let descriptionField = $state<HTMLTextAreaElement | null>(null);
	let draftCurve = $state.raw<Curve | null>(null);
	/** The editor curve's filter labels, frozen with `draftCurve` (published as preset@2). */
	let draftLabels = $state.raw<readonly (string | null)[] | null>(null);
	let draftName = $state('');
	let description = $state('');
	let license = $state<'CC0-1.0' | 'CC-BY-4.0'>('CC0-1.0');
	let visibility = $state<'public' | 'unlisted' | 'private'>('unlisted');
	let issues = $state.raw<TextIssue[]>([]);
	const saving = $derived(mode === 'save');
	const nameIssues = $derived(issues.filter((issue) => issue.field === 'name'));
	const descriptionIssues = $derived(issues.filter((issue) => issue.field === 'description'));
	const otherIssues = $derived(issues.filter((issue) => issue.field === null));

	/** The private lineage this page saved for the signed-in account: saving again adds a version. */
	interface SavedCopy {
		account: string;
		s1: string;
		lineageId: string;
		versionId: string;
		name: string;
		description: string;
		license: 'CC0-1.0' | 'CC-BY-4.0';
		/**
		 * Filter labels of that version as sent (normalized, `@2`), or null: a labels-only change
		 * is a real change and appends a version (migration 0012).
		 */
		labels: readonly (string | null)[] | null;
		/** Editor name at that save: a later rename in the editor wins in the prefill. */
		editorName: string;
	}
	/** The filter labels a checked envelope carries; null for `@1` (no labels). */
	function envelopeLabels(envelope: Record<string, unknown>): (string | null)[] | null {
		const labels: unknown = envelope.labels;
		if (!Array.isArray(labels)) return null;
		return labels.map((label: unknown) => (typeof label === 'string' ? label : null));
	}
	let saved = $state.raw<SavedCopy | null>(null);
	/**
	 * What a fresh read of the saved copy allows. The dialog promises a private copy, and the
	 * server appends to any lineage the owner has: a new version only while it is private and
	 * active (Minha Biblioteca, or another tab, may have published it since).
	 */
	function copyState(lineage: {
		visibility: string;
		status: string;
		headVersion: string | null;
	}): 'private' | 'exposed' | 'gone' {
		if (lineage.status !== 'active' || !lineage.headVersion) return 'gone';
		return lineage.visibility === 'private' ? 'private' : 'exposed';
	}
	const draftS1 = $derived(draftCurve ? currentS1(draftCurve) : null);
	/** The saved copy a "Salvar" of the frozen draft updates (same account, exact same S1). */
	const draftCopy = $derived(
		saving &&
			saved &&
			draftS1 !== null &&
			saved.s1 === draftS1 &&
			saved.account === session.accountId
			? saved
			: null
	);

	async function fetchSession(input: string, init?: RequestInit): Promise<Response> {
		try {
			const response = await fetch(input, init);
			if (response.status >= 500) offline = true;
			return response;
		} catch (cause) {
			offline = true;
			throw cause;
		}
	}

	onMount(() => {
		offline = !navigator.onLine;
		if (!session.known) void session.refresh();
	});
	async function flush(queue: ReturnType<typeof createSocialOutbox>) {
		const report = await queue.flush(api);
		if (report.error === 'NETWORK' || report.error === 'OFFLINE' || report.error === 'INTERNAL') {
			offline = true;
		}
	}
	$effect(() => {
		const queue = outbox;
		if (queue && session.verified && !offline) void flush(queue);
	});

	function failure(cause: unknown) {
		gateMessages = [];
		if (isSocialApiError(cause)) {
			if (cause.unreachable || cause.status >= 500) {
				offline = true;
				message = '';
				return;
			}
			if (cause.code === 'AUTH_REQUIRED') {
				session.set(null);
				message = m.curva_social_login();
				return;
			}
			if (cause.code === 'EMAIL_NOT_VERIFIED') {
				const current = session.account;
				if (current) session.set({ ...current, emailVerified: false });
				message = m.curva_social_verify();
				return;
			}
			if (cause.code === 'GATE_REJECTED') {
				message = m.curva_social_gate();
				gateMessages = serverGateMessages(cause.details);
				return;
			}
			if (cause.code === 'RATE_LIMITED' || cause.code === 'QUOTA_EXCEEDED') {
				message = m.curva_social_limit();
				return;
			}
			if (cause.code === 'INVALID_CURVE') {
				message = m.curva_social_invalid();
				return;
			}
		}
		message =
			cause instanceof EnvelopeError || cause instanceof S1Error
				? m.curva_social_invalid()
				: m.curva_social_error();
	}

	$effect(() => {
		const code = s1;
		void originRevision;
		let cancelled = false;
		found = null;
		if (code) {
			void originOf(code).then((value) => {
				if (!cancelled && value) found = { s1: code, value };
			});
		}
		return () => {
			cancelled = true;
		};
	});

	// Query ids are hints, not proof: confirm the version's exact S1 through the public API.
	$effect(() => {
		const hint = originHint;
		void reconnectRevision;
		if (!hint) return;
		const controller = new AbortController();
		void (async () => {
			try {
				const result = await api.getCurve(
					hint.lineageId,
					{ versionId: hint.versionId },
					{ signal: controller.signal }
				);
				if (
					controller.signal.aborted ||
					result.curve.s1 !== hint.s1 ||
					result.lineage.id !== hint.lineageId ||
					result.version.id !== hint.versionId ||
					!result.curve.gate.ok ||
					result.lineage.visibility === 'private'
				)
					return;
				await rememberOrigin(hint);
				if (!controller.signal.aborted) originRevision++;
			} catch (cause) {
				if (!controller.signal.aborted) failure(cause);
			}
		})();
		return () => controller.abort();
	});

	$effect(() => {
		const instance = preview;
		const code = s1;
		const source = origin;
		const queue = outbox;
		if (!instance?.playing || instance.side !== 'B' || !source || !queue) {
			activity.interrupt();
			return;
		}
		const sessionId = instance.session;
		const timer = setInterval(() => {
			const event = activity.sample(sessionId, code, source, instance.audibleEditorTime());
			// The outbox refuses signed-out or unverified listeners: nothing is kept for later.
			if (event) {
				void queue.enqueue(event).then((result) => {
					if (result.ok) void flush(queue);
				});
			}
		}, 100);
		return () => {
			clearInterval(timer);
			activity.interrupt();
		};
	});

	$effect(() => {
		const source = origin;
		const account = session.account;
		if (!source || !account || offline) return;
		const controller = new AbortController();
		favoriteLoading = true;
		void (async () => {
			try {
				let cursor: string | null = null;
				// Request-local cycle detection, not component state.
				const seen: string[] = [];
				do {
					const result = await api.myLibrary(
						{ shelf: 'favorites', cursor, limit: 100 },
						{ signal: controller.signal }
					);
					if (controller.signal.aborted) return;
					if (result.items.some((item) => item.id === source.lineageId)) {
						favorites[source.lineageId] = true;
						return;
					}
					cursor = result.nextCursor;
					if (cursor && seen.includes(cursor)) return;
					if (cursor) seen.push(cursor);
				} while (cursor);
				favorites[source.lineageId] = false;
			} catch (cause) {
				if (!controller.signal.aborted) failure(cause);
			} finally {
				if (!controller.signal.aborted) favoriteLoading = false;
			}
		})();
		return () => {
			controller.abort();
			favoriteLoading = false;
		};
	});

	function connected() {
		offline = false;
		reconnectRevision++;
		void session.refresh();
	}
	function openDialog(next: 'publish' | 'save') {
		if (unavailable || blockedReason !== null) return;
		mode = next;
		draftCurve = structuredClone($state.snapshot(curve));
		draftLabels = app?.state.curve.current.labels ?? null;
		// `draftCopy` now reads the frozen draft: prefill from the saved copy it would update.
		const copy = draftCopy;
		draftName = copy && copy.editorName === name ? copy.name : name;
		description = copy?.description ?? '';
		license = copy?.license ?? 'CC0-1.0';
		visibility = next === 'save' ? 'private' : 'unlisted';
		message = '';
		gateMessages = [];
		issues = [];
		dialog?.showModal();
		dialogOpen = true;
		nameField?.focus();
	}
	function focusIssue(found: readonly TextIssue[]) {
		if (found.some((issue) => issue.field === 'name')) nameField?.focus();
		else if (found.some((issue) => issue.field === 'description')) descriptionField?.focus();
	}
	async function submit() {
		if (unavailable) return;
		const snapshot = draftCurve;
		if (!snapshot) return;
		// The exact draft that would be sent passes the standard gate, whatever the editor's profile
		// was: a YOLO-only curve never reaches the account (the server refuses it as well).
		const refused = exitRefusal(snapshot);
		if (refused) {
			message = exitRefusalText(refused, snapshot, locale);
			gateMessages = [];
			issues = [];
			return;
		}
		const copy = draftCopy;
		const account = session.accountId;
		const chosen = copy?.license ?? license;
		message = '';
		gateMessages = [];
		issues = [];
		// Same core rules as the server (lengths, lines, links, control characters): nothing is
		// sent while the text cannot be published.
		const checked = checkEnvelope(
			socialEnvelope(snapshot, {
				name: draftName,
				description,
				license: chosen,
				locale,
				labels: draftLabels
			})
		);
		if (!checked.ok) {
			issues = checked.issues;
			message = m.cvedit_invalid();
			focusIssue(checked.issues);
			return;
		}
		busy = true;
		const labels = envelopeLabels(checked.envelope);
		/** The saved copy this submit still targets; null once a new lineage is created instead. */
		let target = copy;
		let notice = '';
		try {
			if (target) {
				// Never trust a remembered visibility: read the lineage right before appending.
				const current = await api.getLineage(target.lineageId);
				const state = copyState(current.lineage);
				if (state === 'gone') {
					saved = null;
					message = m.cvedit_save_gone();
					return;
				}
				const unchanged =
					checked.name === target.name &&
					checked.description === target.description &&
					sameLabels(labels, target.labels);
				if (state === 'exposed') {
					// No longer private: leave it untouched and keep the promise with a new private copy.
					saved = null;
					target = null;
					notice = m.cvedit_save_not_private();
				} else if (unchanged) {
					message = m.cvedit_save_unchanged();
					dialog?.close();
					return;
				}
			}
			if (target) {
				// Name, description and filter labels live on the (append-only) version: a new
				// version, same lineage.
				const result = await api.appendVersion(target.lineageId, {
					parentVersionId: target.versionId,
					envelope: checked.envelope
				});
				saved = {
					...target,
					versionId: result.versionId,
					name: checked.name,
					description: checked.description,
					labels,
					editorName: name
				};
				message = m.cvedit_save_updated();
				dialog?.close();
				return;
			}
			const targetVisibility = saving ? 'private' : visibility;
			const result = await api.publishCurve({
				envelope: checked.envelope,
				visibility: targetVisibility
			});
			if (targetVisibility === 'private') {
				if (account) {
					saved = {
						account,
						s1: checked.code,
						lineageId: result.lineageId,
						versionId: result.versionId,
						name: checked.name,
						description: checked.description,
						license: chosen,
						labels,
						editorName: name
					};
				}
			} else {
				await rememberOrigin({
					s1: checked.code,
					lineageId: result.lineageId,
					versionId: result.versionId
				});
				originRevision++;
			}
			message =
				notice ||
				(targetVisibility === 'private' ? m.curva_social_saved() : m.curva_social_published());
			dialog?.close();
		} catch (cause) {
			if (target) await copyFailed(target, cause);
			else {
				failure(cause);
				// The exposed copy is already forgotten: say why the next save creates a new one.
				if (notice) {
					const retry = m.cvedit_save_not_private_retry();
					message = message ? `${retry} ${message}` : retry;
				}
			}
		} finally {
			busy = false;
		}
	}
	/** The read before a new version, or the new version, failed: its head moved, or it is gone. */
	async function copyFailed(copy: SavedCopy, cause: unknown) {
		if (!isSocialApiError(cause) || cause.unreachable || cause.status >= 500) {
			failure(cause);
			return;
		}
		if (cause.code === 'CONFLICT' || cause.code === 'NOT_FOUND' || cause.code === 'GONE') {
			// Retracted or deleted elsewhere: the next "Salvar" creates a new private copy.
			saved = null;
			gateMessages = [];
			message = m.cvedit_save_gone();
			return;
		}
		if (cause.code !== 'HEAD_MOVED') {
			failure(cause);
			return;
		}
		gateMessages = [];
		message = m.cvedit_head_moved();
		try {
			const current = await api.getLineage(copy.lineageId);
			const headId = current.lineage.headVersion;
			const head = current.versions.find((version) => version.id === headId);
			const state = copyState(current.lineage);
			if (state === 'gone' || !headId) {
				saved = null;
				message = m.cvedit_save_gone();
				return;
			}
			if (state === 'exposed') {
				// Published or unlisted meanwhile: never reload it as the private copy to update.
				saved = null;
				message = m.cvedit_save_not_private_retry();
				return;
			}
			saved = {
				...copy,
				versionId: headId,
				name: head?.name ?? copy.name,
				description: head?.description ?? copy.description,
				labels: head ? head.labels : copy.labels
			};
		} catch (reload) {
			// The copy stays as it was: the next "Salvar" meets HEAD_MOVED again and reloads.
			if (!isSocialApiError(reload) || reload.unreachable || reload.status >= 500) {
				failure(reload);
			}
		}
	}
	async function toggleFavorite() {
		const source = origin;
		if (unavailable || favoriteLoading || !source) return;
		busy = true;
		message = '';
		try {
			const result = favorites[source.lineageId]
				? await api.unfavorite(source.lineageId)
				: await api.favorite(source.lineageId);
			favorites[source.lineageId] = result.favorited;
		} catch (cause) {
			failure(cause);
		} finally {
			busy = false;
		}
	}
	async function share() {
		const source = origin;
		const code = s1;
		if (unavailable || blockedReason !== null || !source || !code) return;
		busy = true;
		message = '';
		try {
			const result = await api.createShare({
				lineageId: source.lineageId,
				versionId: source.versionId,
				channel: 'link'
			});
			// Construct locally; never trust an API-provided URL as a navigation target.
			const path = `/c/${encodeURIComponent(source.lineageId)}?s=${encodeURIComponent(result.shareId)}`;
			shared = { s1: code, url: new URL(path, pageUrl.href).href };
		} catch (cause) {
			failure(cause);
		} finally {
			busy = false;
		}
	}
	async function copy() {
		try {
			await clipboard(link);
			message = m.curva_link_copied();
		} catch (cause) {
			console.warn(
				'Curva short link clipboard unavailable',
				cause instanceof Error ? cause.name : 'unknown'
			);
			message = m.curva_link_copy_failed();
		}
	}
</script>

<svelte:window ononline={connected} onoffline={() => (offline = true)} />

<Panel
	variant="hardware"
	class="social"
	eyebrow={m.curva_v2_social_eyebrow()}
	title={m.curva_social_heading()}
>
	{#if !session.signedIn}
		<a class="login" href={loginHref}>{m.curva_social_login()}</a>
	{:else if !session.verified}
		<p>{m.curva_social_verify()} <a href="/conta">{m.curva_social_account()}</a></p>
	{/if}
	<div class="actions">
		<Button
			size="sm"
			caps
			aria-haspopup="dialog"
			disabledReason={exitReason}
			onclick={() => openDialog('save')}>{m.curva_social_save()}</Button
		>
		<Button size="sm" caps disabledReason={exitReason} onclick={() => openDialog('publish')}
			>{m.curva_social_publish()}</Button
		>
		{#if origin}
			<Button
				size="sm"
				caps
				disabledReason={reason ?? (favoriteLoading ? m.curva_v2_social_busy_reason() : null)}
				aria-pressed={favorites[origin.lineageId] ?? false}
				onclick={() => void toggleFavorite()}
			>
				{favorites[origin.lineageId] ? m.curva_social_unfavorite() : m.curva_social_favorite()}
			</Button>
			<a
				class="btn btn--plate btn--sm btn--caps"
				href={`/c/${encodeURIComponent(origin.lineageId)}`}>{m.curva_social_open()}</a
			>
			<Button size="sm" caps disabledReason={exitReason} onclick={() => void share()}
				>{m.curva_social_share()}</Button
			>
		{:else}
			<span class="note">{m.curva_social_share_publish()}</span>
		{/if}
	</div>
	{#if offline}
		<p class="note" role="status">{m.curva_social_offline()}</p>
	{/if}
	{#if link}
		<label>
			{m.curva_social_link()}
			<input readonly value={link} onfocus={(event) => event.currentTarget.select()} />
		</label>
		<Button size="sm" caps onclick={() => void copy()}>{m.curva_social_copy()}</Button>
	{/if}
	<p class="note">{m.curva_social_fallback()}</p>
	<div role="status" aria-live="polite">
		{message}
		{#if !dialogOpen && gateMessages.length}
			<ul>
				{#each gateMessages as text, index (`${index}:${text}`)}
					<li>{text}</li>
				{/each}
			</ul>
		{/if}
	</div>
</Panel>

<dialog
	bind:this={dialog}
	aria-labelledby={`${headingId}-dialog`}
	onclose={() => (dialogOpen = false)}
	oncancel={(event) => {
		if (busy) event.preventDefault();
	}}
>
	<form
		onsubmit={(event) => {
			event.preventDefault();
			void submit();
		}}
	>
		<h2 id={`${headingId}-dialog`}>
			{saving ? m.curva_social_save() : m.curva_social_publish()}
		</h2>
		<label>
			{m.curva_social_name()}
			<input
				bind:this={nameField}
				required
				maxlength="48"
				bind:value={draftName}
				disabled={busy}
				aria-invalid={nameIssues.length > 0 ? 'true' : undefined}
				aria-describedby={nameIssues.length > 0 ? `${headingId}-name-issue` : undefined}
			/>
		</label>
		{#if nameIssues.length}
			<p class="issue" id={`${headingId}-name-issue`}>
				{nameIssues.map(textIssueText).join(' ')}
			</p>
		{/if}
		<label>
			{m.curva_social_description()}
			<textarea
				bind:this={descriptionField}
				maxlength="280"
				bind:value={description}
				disabled={busy}
				aria-invalid={descriptionIssues.length > 0 ? 'true' : undefined}
				aria-describedby={descriptionIssues.length > 0
					? `${headingId}-description-issue`
					: saving
						? `${headingId}-description-hint`
						: undefined}></textarea>
		</label>
		{#if descriptionIssues.length}
			<p class="issue" id={`${headingId}-description-issue`}>
				{descriptionIssues.map(textIssueText).join(' ')}
			</p>
		{:else if saving}
			<p class="note" id={`${headingId}-description-hint`}>{m.cvedit_description_hint()}</p>
		{/if}
		{#if saving}
			<p class="note">{m.cvedit_save_private()}</p>
			{#if draftCopy}<p class="note">{m.cvedit_save_version_page()}</p>{/if}
		{:else}
			<label>
				{m.curva_social_license()}
				<select bind:value={license} disabled={busy}>
					<option value="CC0-1.0">CC0</option>
					<option value="CC-BY-4.0">CC-BY 4.0</option>
				</select>
			</label>
			<label>
				{m.curva_social_visibility()}
				<select bind:value={visibility} disabled={busy}>
					<option value="public">{m.curva_social_public()}</option>
					<option value="unlisted">{m.curva_social_unlisted()}</option>
					<option value="private">{m.curva_social_private()}</option>
				</select>
			</label>
		{/if}
		{#if offline}
			<p class="note" role="status">{m.curva_social_offline()}</p>
		{/if}
		<div role="status" aria-live="polite">
			{message}
			{#if otherIssues.length}
				<ul>
					{#each otherIssues as issue (issue.code)}
						<li>{textIssueText(issue)}</li>
					{/each}
				</ul>
			{/if}
			{#if gateMessages.length}
				<ul>
					{#each gateMessages as text, index (`${index}:${text}`)}
						<li>{text}</li>
					{/each}
				</ul>
			{/if}
		</div>
		<div class="actions">
			<Button variant="primary" type="submit" loading={busy} disabledReason={busy ? null : exitReason}
				>{busy
					? m.curva_social_busy()
					: saving
						? m.cvedit_save_confirm()
						: m.curva_social_publish()}</Button
			>
			<Button
				variant="ghost"
				disabledReason={busy ? m.curva_v2_social_busy_reason() : null}
				onclick={() => dialog?.close()}>{m.curva_social_cancel()}</Button
			>
		</div>
	</form>
</dialog>

<style>
	/* Rack panel under the instrument: the Curva satin with a wood-grain top edge. */
	:global(.panel.social) {
		--panel-material: linear-gradient(180deg, #2e2d2b, #1f1e1c);
		border-top: 3px solid #4b2b16;
		font: 400 var(--fs-small) / var(--lh-small) var(--face-body);
	}
	h2 {
		margin: 0 0 10px;
		font: 400 var(--fs-title) / var(--lh-title) var(--face-display);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
		margin: 10px 0;
	}
	.note {
		color: var(--muted);
		font: 400 var(--fs-caption) / var(--lh-small) var(--face-body);
	}
	.issue {
		margin: -6px 0 12px;
		color: var(--warn);
		font: 400 var(--fs-caption) / var(--lh-small) var(--face-body);
	}
	[aria-invalid='true'] {
		border-color: var(--warn);
	}
	a:not(.btn) {
		color: var(--accent-text);
	}
	.login {
		font: 500 var(--fs-ui) / var(--lh-ui) var(--face-body);
	}
	label {
		display: grid;
		gap: 4px;
		margin: 12px 0;
	}
	input,
	textarea,
	select {
		box-sizing: border-box;
		width: 100%;
		min-height: 36px;
		padding: 6px 8px;
		color: var(--text);
		background: var(--ink);
		border: 1px solid var(--rule-control);
		border-radius: var(--rad-sm);
		font: 400 var(--fs-ui) / var(--lh-ui) var(--face-body);
	}
	textarea {
		min-height: 80px;
		resize: vertical;
	}
	dialog {
		width: min(480px, calc(100vw - 48px));
		max-height: 85vh;
		overflow: auto;
		padding: 20px;
		color: var(--text);
		background: var(--ink-3);
		border: 1px solid var(--rule-control);
		border-radius: var(--rad-lg);
		box-shadow: var(--elev-3);
	}
	dialog::backdrop {
		background: rgb(0 0 0 / 0.7);
	}
	:focus-visible {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: var(--focus-offset);
	}
</style>
