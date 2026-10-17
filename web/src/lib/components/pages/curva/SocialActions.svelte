<script lang="ts">
	import { onMount } from 'svelte';
	import { EnvelopeError, S1Error } from 'open-auri/share';
	import type { ClientApp } from '#lib/app/index.ts';
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
	import {
		currentS1,
		curvaSocialApi,
		PreviewActivity,
		serverGateMessages,
		socialEnvelope
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
	}
	let {
		app,
		curve,
		name,
		locale,
		pageUrl,
		preview = null,
		originHint = null,
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
	const loginHref = $derived(
		requireLoginHref(new URL(pageUrl.href).pathname + new URL(pageUrl.href).search)
	);
	const outbox = $derived(app ? createSocialOutbox({ store: app.state.outbox, session }) : null);
	const activity = new PreviewActivity();
	let dialog = $state<HTMLDialogElement | null>(null);
	let dialogOpen = $state(false);
	let draftCurve = $state.raw<Curve | null>(null);
	let draftName = $state('');
	let description = $state('');
	let license = $state<'CC0-1.0' | 'CC-BY-4.0'>('CC0-1.0');
	let visibility = $state<'public' | 'unlisted' | 'private'>('public');

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
	function openPublish() {
		if (unavailable) return;
		draftCurve = structuredClone($state.snapshot(curve));
		draftName = name;
		description = '';
		license = 'CC0-1.0';
		visibility = 'public';
		message = '';
		gateMessages = [];
		dialog?.showModal();
		dialogOpen = true;
	}
	async function publish(privateSave = false) {
		if (unavailable) return;
		const snapshot = privateSave ? structuredClone($state.snapshot(curve)) : draftCurve;
		if (!snapshot) return;
		busy = true;
		message = '';
		gateMessages = [];
		try {
			const targetVisibility = privateSave ? 'private' : visibility;
			const envelope = socialEnvelope(snapshot, {
				name: privateSave ? name : draftName,
				description: privateSave ? '' : description,
				license: privateSave ? 'CC0-1.0' : license,
				locale
			});
			const result = await api.publishCurve({ envelope, visibility: targetVisibility });
			if (targetVisibility !== 'private') {
				await rememberOrigin({
					s1: envelope.code,
					lineageId: result.lineageId,
					versionId: result.versionId
				});
				originRevision++;
			}
			message =
				targetVisibility === 'private' ? m.curva_social_saved() : m.curva_social_published();
			if (!privateSave) dialog?.close();
		} catch (cause) {
			failure(cause);
		} finally {
			busy = false;
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
		if (unavailable || !source || !code) return;
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
		<Button size="sm" caps disabledReason={reason} onclick={() => void publish(true)}
			>{m.curva_social_save()}</Button
		>
		<Button size="sm" caps disabledReason={reason} onclick={openPublish}
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
			<Button size="sm" caps disabledReason={reason} onclick={() => void share()}
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
			void publish();
		}}
	>
		<h2 id={`${headingId}-dialog`}>{m.curva_social_publish()}</h2>
		<label>
			{m.curva_social_name()}
			<input required maxlength="48" bind:value={draftName} disabled={busy} />
		</label>
		<label>
			{m.curva_social_description()}
			<textarea maxlength="280" bind:value={description} disabled={busy}></textarea>
		</label>
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
		{#if offline}
			<p class="note" role="status">{m.curva_social_offline()}</p>
		{/if}
		<div role="status">
			{message}
			{#if gateMessages.length}
				<ul>
					{#each gateMessages as text, index (`${index}:${text}`)}
						<li>{text}</li>
					{/each}
				</ul>
			{/if}
		</div>
		<div class="actions">
			<Button variant="primary" type="submit" loading={busy} disabledReason={busy ? null : reason}
				>{busy ? m.curva_social_busy() : m.curva_social_publish()}</Button
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
