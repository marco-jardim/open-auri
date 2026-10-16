<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { POLICY_VERSION } from '#lib/content/legal/version.ts';

	interface Props {
		/** Version currently published (defaults to POLICY_VERSION). */
		version?: string;
		/**
		 * Last version this visitor saw: from `resolveAnonymousSeen()` (anonymous) or from the
		 * server's policy_acceptances (signed in). `null` means "none recorded".
		 */
		seenVersion: string | null;
		/** Persists the acknowledgement. A rejection keeps the banner open with an error. */
		onAccept: (version: string) => void | Promise<void>;
	}

	let { version = POLICY_VERSION, seenVersion, onAccept }: Props = $props();
	const uid = $props.id();

	let acknowledged = $state<string | null>(null);
	let busy = $state(false);
	let failed = $state(false);
	const visible = $derived(seenVersion !== version && acknowledged !== version);

	async function accept() {
		if (busy) return;
		busy = true;
		failed = false;
		const current = version;
		try {
			await onAccept(current);
			acknowledged = current;
		} catch {
			failed = true;
		} finally {
			busy = false;
		}
	}
</script>

{#if visible}
	<section class="policy-banner" aria-labelledby="{uid}-title" data-policy-version={version}>
		<div class="text">
			<h2 id="{uid}-title">{m.legal_banner_title()}</h2>
			<p>{m.legal_banner_body({ version })}</p>
			<p class="links">
				<a href="/privacidade">{m.legal_banner_privacy()}</a>
				<a href="/termos">{m.legal_banner_terms()}</a>
			</p>
			{#if failed}<p class="error" role="alert">{m.legal_banner_error()}</p>{/if}
		</div>
		<button type="button" onclick={accept} disabled={busy} aria-busy={busy}>
			{busy ? m.legal_banner_busy() : m.legal_banner_accept()}
		</button>
	</section>
{/if}

<style>
	.policy-banner {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 12px 24px;
		padding: 12px 18px;
		border-top: 2px solid #dea6a0;
		background: #121211;
		color: #ece7dd;
		font: 13px/1.5 var(--ui, 'Geist', system-ui, sans-serif);
	}

	.text {
		flex: 1 1 320px;
		min-width: 0;
	}

	h2 {
		margin: 0;
		font: 600 13px/1.4 var(--ui, 'Geist', system-ui, sans-serif);
	}

	p {
		margin: 4px 0 0;
		color: #b5afa4;
		overflow-wrap: anywhere;
	}

	.links {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 18px;
	}

	a {
		color: #dea6a0;
		text-decoration-line: underline;
		text-underline-offset: 3px;
	}

	.error {
		color: #ffb4a8;
	}

	button {
		min-height: 32px;
		padding: 6px 16px;
		border: 1px solid #dea6a0;
		border-radius: 3px;
		background: transparent;
		color: #ece7dd;
		font: 600 12px/1.3 var(--mono, 'JetBrains Mono', monospace);
		letter-spacing: 0.04em;
		cursor: pointer;
	}

	button:disabled {
		cursor: progress;
		opacity: 0.7;
	}

	a:focus-visible,
	button:focus-visible {
		outline: 2px solid #dea6a0;
		outline-offset: 3px;
	}
</style>
