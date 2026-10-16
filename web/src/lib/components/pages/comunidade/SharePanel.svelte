<!--
	Sharing desk (S10/S8) for the scope target: the server's OG image (before/after response, S10),
	a printable identity card with the S8 avatar, the S1 code and a QR of a tracked share link
	(`POST /api/v1/shares`, sign-in required). The QR comes from `#lib/qr` (uqr) as an <img>; no
	text is ever injected as markup.
-->
<script lang="ts">
	import { qrSvg } from '#lib/qr/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import type { CreatedShare, SocialApi } from '#lib/social/index.ts';
	import CurveAvatar from './CurveAvatar.svelte';
	import LoginPrompt from './LoginPrompt.svelte';
	import { absoluteUrl, errorText, licenseShort, type Channel, type SessionView } from './model.ts';

	let {
		api,
		session,
		channel,
		online
	}: { api: SocialApi; session: SessionView; channel: Channel | null; online: boolean } = $props();

	const id = $props.id();
	let share = $state.raw<{ lineageId: string; created: CreatedShare } | null>(null);
	let busy = $state(false);
	let message = $state('');

	const current = $derived(
		share && channel && share.lineageId === channel.lineageId ? share : null
	);
	const url = $derived(current ? absoluteUrl(current.created.url) : '');
	const qr = $derived(url ? `data:image/svg+xml,${encodeURIComponent(qrSvg(url))}` : '');

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

<section class="share panel" aria-labelledby="{id}-title">
	<div class="sec-head">
		<h2 id="{id}-title">{m.comunidade_share_title()}</h2>
		<p>{m.comunidade_share_lede()}</p>
	</div>
	{#if !channel}
		<p class="note">{m.comunidade_select_first()}</p>
	{:else}
		<div class="share-grid">
			<div>
				<div class="s10-frame">
					<img
						src={api.ogImageUrl(channel.versionId)}
						alt={m.comunidade_share_og_alt({ name: channel.name })}
						width="1200"
						height="630"
						loading="lazy"
					/>
				</div>
				<div class="row-btns">
					<a class="btn" href={api.ogImageUrl(channel.versionId)} download
						>{m.comunidade_share_download_png()}</a
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
					<div class="qr-wrap">
						{#if qr}
							<img src={qr} alt={m.comunidade_share_qr_alt()} width="92" height="92" />
						{:else}
							<span class="qr-empty">{m.comunidade_share_qr_pending()}</span>
						{/if}
					</div>
				</div>
				{#if session.verified}
					<div class="row-btns">
						<button type="button" class="btn primary" disabled={busy || !online} onclick={create}
							>{m.comunidade_share_create()}</button
						>
						{#if url}
							<button type="button" class="btn" onclick={copy}>{m.comunidade_share_copy()}</button>
						{/if}
					</div>
					{#if url}<p class="share-url" data-testid="share-url">{url}</p>{/if}
				{:else}
					<LoginPrompt signedIn={session.signedIn} />
				{/if}
				<p class="note" role="status">{message}</p>
			</div>
		</div>
	{/if}
</section>

<style>
	.share {
		background: linear-gradient(180deg, #2c2f33, #1e2023);
	}
	.share-grid {
		display: grid;
		grid-template-columns: 1.35fr 1fr;
		gap: 20px;
		align-items: start;
	}
	.s10-frame {
		border: 10px solid #15161a;
		border-radius: 6px;
		background: #0d0e10;
	}
	.s10-frame img {
		display: block;
		width: 100%;
		height: auto;
	}
	.print-card {
		width: 100%;
		max-width: 470px;
		display: grid;
		grid-template-columns: 110px 1fr 96px;
		gap: 12px;
		align-items: center;
		padding: 14px;
		background: linear-gradient(135deg, #fbf9f3, #ebe6d9);
		color: #1b1b1b;
		border-radius: 10px;
		box-shadow: 0 14px 26px #000b;
		--avatar-bg: #14161a;
	}
	.pc-text p {
		margin: 0;
	}
	.pc-name {
		font: italic 24px/1 var(--serif);
		overflow-wrap: anywhere;
	}
	.pc-h {
		font: 12px var(--marker);
		color: var(--marker-ink);
		margin-top: 4px !important;
	}
	.pc-code {
		font: 8.5px/1.45 var(--mono);
		margin-top: 8px !important;
		color: #333;
		word-break: break-all;
	}
	.pc-meta {
		font: 8px var(--mono);
		color: #555;
		margin-top: 6px !important;
	}
	.qr-wrap {
		text-align: center;
		font: 8px var(--mono);
		color: #555;
	}
	.qr-wrap img {
		display: block;
		width: 92px;
		height: 92px;
	}
	.share-url {
		font: 11px var(--mono);
		color: #cfcbc1;
		word-break: break-all;
		margin: 8px 0 0;
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
