<!--
	Sharing desk for the scope target: the server's OG image (before/after response), a printable
	identity card with the curve avatar, the curve code and a QR of a tracked share link
	(`POST /api/v1/shares`, a verified account required). No text is ever injected as markup.

	Loading (spec §5.3 L6): the page mounts this panel only when its drawer opens, and the QR module
	(`#lib/qr`, uqr) is imported here on mount, so it never sits in the route's static closure.
-->
<script lang="ts">
	import Button from '#lib/components/primitives/Button.svelte';
	import { m } from '#lib/paraglide/messages.js';
	import {
		dispositionFilename,
		isAndroidApp,
		saveFile,
		saveFileErrorMessage
	} from '#lib/files/save.ts';
	import type { CreatedShare, SocialApi } from '#lib/social/index.ts';
	import CurveAvatar from './CurveAvatar.svelte';
	import { absoluteUrl, errorText, licenseShort, type Channel, type SessionView } from './model.ts';

	type QrModule = typeof import('#lib/qr/index.ts');

	let {
		api,
		session,
		channel,
		online
	}: { api: SocialApi; session: SessionView; channel: Channel | null; online: boolean } = $props();

	let share = $state.raw<{ lineageId: string; created: CreatedShare } | null>(null);
	let busy = $state(false);
	let message = $state('');
	let qrModule = $state.raw<QrModule | null>(null);

	$effect(() => {
		let live = true;
		import('#lib/qr/index.ts')
			.then((module) => {
				if (live) qrModule = module;
			})
			.catch((error: unknown) => {
				console.warn(
					JSON.stringify({
						event: 'comunidade.qr_import_failed',
						error: error instanceof Error ? error.name : 'unknown'
					})
				);
			});
		return () => {
			live = false;
		};
	});

	const current = $derived(
		share && channel && share.lineageId === channel.lineageId ? share : null
	);
	const url = $derived(current ? absoluteUrl(current.created.url) : '');
	const qr = $derived(
		url && qrModule ? `data:image/svg+xml,${encodeURIComponent(qrModule.qrSvg(url))}` : ''
	);
	const createReason = $derived(
		!session.verified
			? session.signedIn
				? m.comunidade_verify_prompt()
				: m.comunidade_v2_reason_account()
			: !online
				? m.comunidade_offline()
				: null
	);

	async function create() {
		if (!channel || !session.verified || busy) return;
		busy = true;
		message = '';
		try {
			const created = await api.createShare({
				lineageId: channel.lineageId,
				versionId: channel.versionId,
				channel: 'qr'
			});
			share = { lineageId: channel.lineageId, created };
		} catch (error) {
			message = errorText(error);
		} finally {
			busy = false;
		}
	}

	async function downloadPng(event: MouseEvent) {
		if (!isAndroidApp()) return;
		event.preventDefault();
		if (!channel) return;
		message = '';
		try {
			const response = await fetch(api.ogImageUrl(channel.versionId), {
				credentials: 'same-origin'
			});
			if (!response.ok) throw new Error(`PNG download: ${response.status}`);
			await saveFile({
				name:
					dispositionFilename(response.headers.get('content-disposition')) ??
					`${channel.versionId}.png`,
				mime: 'image/png',
				bytes: await response.blob()
			});
		} catch (error) {
			message = saveFileErrorMessage(error, m.comunidade_error_generic());
			console.error('Community PNG export failed', error);
		}
	}

	async function copy() {
		if (!url) return;
		try {
			await navigator.clipboard.writeText(url);
			message = m.comunidade_share_copied();
		} catch (error) {
			message = m.comunidade_share_copy_failed();
			console.warn(
				JSON.stringify({
					event: 'comunidade.copy_failed',
					error: error instanceof Error ? error.name : 'unknown'
				})
			);
		}
	}
</script>

<div class="share" data-testid="share-panel">
	{#if !channel}
		<p class="note">{m.comunidade_select_first()}</p>
	{:else}
		<div class="share-grid">
			<div>
				<div class="og-frame">
					<img
						src={api.ogImageUrl(channel.versionId)}
						alt={m.comunidade_share_og_alt({ name: channel.name })}
						width="1200"
						height="630"
						loading="lazy"
					/>
				</div>
				<div class="row-btns">
					<a
						class="btn btn--plate btn--md"
						href={api.ogImageUrl(channel.versionId)}
						download
						onclick={downloadPng}>{m.comunidade_share_download_png()}</a
					>
				</div>
			</div>
			<div>
				<div class="print-card">
					<div class="pc-glyph">
						<CurveAvatar
							curve={channel.curve}
							s1={channel.s1}
							size={110}
							label={m.comunidade_avatar_label({ name: channel.name })}
						/>
					</div>
					<div class="pc-text">
						<p class="pc-name">{channel.name}</p>
						<p class="pc-h">
							{channel.author
								? `@${channel.author.displayUsername}`
								: m.comunidade_author_removed()}
						</p>
						<p class="pc-code">{channel.s1}</p>
						<p class="pc-meta">{licenseShort(channel.license)} · open-auri</p>
					</div>
					<div class="qr-wrap" data-testid="share-qr">
						{#if qr}
							<img src={qr} alt={m.comunidade_share_qr_alt()} width="92" height="92" />
						{:else}
							<span class="qr-empty">{m.comunidade_share_qr_pending()}</span>
						{/if}
					</div>
				</div>
				<div class="row-btns">
					<Button variant="primary" disabledReason={createReason} loading={busy} onclick={create}
						>{m.comunidade_share_create()}</Button
					>
					{#if url}
						<Button onclick={copy}>{m.comunidade_share_copy()}</Button>
					{/if}
				</div>
				{#if url}<p class="share-url" data-testid="share-url">{url}</p>{/if}
				<p class="note" role="status">{message}</p>
			</div>
		</div>
	{/if}
</div>

<style>
	.share {
		padding-top: var(--space-3);
	}
	.share-grid {
		display: grid;
		grid-template-columns: 1.35fr 1fr;
		gap: var(--space-5);
		align-items: start;
	}
	.og-frame {
		border: 10px solid #15161a;
		border-radius: var(--rad-lg);
		background: #0d0e10;
	}
	.og-frame img {
		display: block;
		width: 100%;
		height: auto;
	}
	.print-card {
		box-sizing: border-box;
		width: 100%;
		max-width: 470px;
		display: grid;
		grid-template-columns: 110px 1fr 96px;
		gap: var(--space-3);
		align-items: center;
		padding: 14px;
		background: linear-gradient(135deg, #fbf9f3, #ebe6d9);
		color: #1b1b1b;
		border-radius: var(--rad-xl);
		box-shadow: 0 14px 26px #000b;
		--avatar-bg: #14161a;
	}
	.pc-text p {
		margin: 0;
	}
	.pc-name {
		font: italic 400 var(--fs-title) / 1 var(--face-display);
		overflow-wrap: anywhere;
	}
	.pc-h {
		margin-top: var(--space-1) !important;
		color: var(--marker-ink);
		font: var(--fs-caption) var(--marker);
	}
	/* Printed card: the code is set small on purpose (it is also in the QR and the link). */
	.pc-code {
		margin-top: var(--space-2) !important;
		color: #333;
		font: 400 var(--label-min) / 1.45 var(--face-data);
		word-break: break-all;
	}
	.pc-meta {
		margin-top: 6px !important;
		color: #555;
		font: 400 var(--label-min) var(--face-data);
	}
	.qr-wrap {
		color: #555;
		font: var(--label-min) / 1.3 var(--face-body);
		text-align: center;
	}
	.qr-wrap img {
		display: block;
		width: 92px;
		height: 92px;
	}
	.share-url {
		margin: var(--space-2) 0 0;
		color: var(--text-2);
		font: 400 var(--fs-caption) var(--face-data);
		word-break: break-all;
	}
	@media (max-width: 1000px) {
		.share-grid {
			grid-template-columns: 1fr;
		}
	}
	@media (max-width: 640px) {
		.print-card {
			grid-template-columns: 80px 1fr 76px;
		}
	}
</style>
