<script lang="ts">
	import { onMount } from 'svelte';
	// Two-step verification (TOTP) in /conta. Three form actions, all working without JavaScript:
	//   ?/twoFactorStart (password) → the action result carries the otpauth URI and the backup
	//     codes, rendered here once (QR, manual key, codes with copy/download);
	//   ?/twoFactorConfirm (6-digit code) → 2FA on;
	//   ?/twoFactorDisable (password + current code or backup code) → 2FA off; (password alone)
	//     → a pending setup cancelled. Confirm and disable redirect back with a success notice.
	// The URI and the codes only live in the action result and, with JavaScript, in this
	// component's memory until the setup is confirmed or cancelled: never in storage, a cookie or
	// the URL.
	import { m } from '#lib/paraglide/messages.js';
	// Server render only (the setup works without JavaScript). In the client build
	// `import.meta.env.SSR` is false, so this binding is unused and the encoder (side-effect free,
	// like uqr) leaves /conta's initial JS; the browser imports it when an enrolment appears (FUX.B).
	import { qrSvg as serverQrSvg } from '#lib/qr/index.ts';
	import Button from '#lib/components/primitives/Button.svelte';
	import Field from '#lib/components/primitives/Field.svelte';
	import { feedbackMessage } from './format.ts';
	import {
		feedbackFor,
		noEnhance,
		type FormEnhance,
		type FormFeedback,
		type TwoFactorEnrolmentView,
		type TwoFactorStatus
	} from './types.ts';
	import './account.css';

	interface Props {
		status: TwoFactorStatus;
		/** Admin account: 2FA is required for /admin and its changes need the session's 2FA marker. */
		admin?: boolean;
		feedback?: FormFeedback | null;
		enhance?: FormEnhance;
	}

	let { status, admin = false, feedback = null, enhance = noEnhance }: Props = $props();

	const uid = $props.id();
	const mine = $derived(feedbackFor(feedback, 'twoFactor'));

	// With JavaScript the setup stays on screen after a mistyped code (the next action result no
	// longer carries it); it goes away once confirmed or cancelled.
	let held = $state<TwoFactorEnrolmentView | null>(null);
	$effect.pre(() => {
		const current = mine;
		if (current?.enrolment) held = current.enrolment;
		else if (current?.ok) held = null;
	});
	const enrolment = $derived(status === 'pending' ? (mine?.enrolment ?? held) : null);

	/** Base32 key of the URI, in groups of four for typing (apps ignore the spaces). */
	function manualKey(uri: string): string {
		let secret: string;
		try {
			secret = new URL(uri).searchParams.get('secret') ?? '';
		} catch {
			// Malformed URI: no manual key (the QR and the full link are still shown).
			secret = '';
		}
		return (secret.match(/.{1,4}/g) ?? []).join(' ');
	}

	const key = $derived(enrolment ? manualKey(enrolment.totpURI) : '');
	let browserQrSvg = $state.raw<((value: string) => string) | null>(null);
	$effect(() => {
		if (!enrolment || browserQrSvg) return;
		import('#lib/qr/index.ts').then(
			(module) => {
				browserQrSvg = module.qrSvg;
			},
			// The manual key and the full link below stay usable without the image.
			(error: unknown) => console.error('The QR encoder could not load', error)
		);
	});
	const encode = $derived(import.meta.env.SSR ? serverQrSvg : browserQrSvg);
	const qr = $derived(
		enrolment && encode ? `data:image/svg+xml,${encodeURIComponent(encode(enrolment.totpURI))}` : ''
	);
	/** The codes as a .txt download (a data: URL: works without JavaScript, nothing is uploaded). */
	function codesFileOf(codes: readonly string[]): string {
		return `data:text/plain;charset=utf-8,${encodeURIComponent(`${codes.join('\n')}\n`)}`;
	}

	const codesFile = $derived(enrolment ? codesFileOf(enrolment.backupCodes) : '');

	const statusText = $derived(
		status === 'on'
			? m.conta_2fa_status_on()
			: status === 'pending'
				? m.conta_2fa_status_pending()
				: m.conta_2fa_status_off()
	);

	// The copy button needs JavaScript: it only appears once mounted.
	let copied = $state('');
	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});

	async function copyCodes(): Promise<void> {
		if (!enrolment) return;
		try {
			await navigator.clipboard.writeText(enrolment.backupCodes.join('\n'));
			copied = m.conta_2fa_codes_copied();
		} catch {
			// Clipboard refused (permissions, insecure context): the download link still works.
			copied = m.conta_2fa_codes_copy_failed();
		}
	}

	// Focus: the setup heading when the setup appears, the status line when the state changes.
	const focusOnMount = (node: HTMLElement) => {
		node.focus();
	};
	let statusLine = $state<HTMLElement | undefined>();
	let lastStatus: TwoFactorStatus | null = null;
	$effect(() => {
		const current = status;
		if (lastStatus !== null && current !== lastStatus && !enrolment) statusLine?.focus();
		lastStatus = current;
	});
</script>

<div class="tf">
	<p class="acc-hint">{m.conta_2fa_intro()}</p>
	<p class="status" tabindex="-1" bind:this={statusLine} data-testid="two-factor-status">
		<span class="acc-label">{m.conta_2fa_status_label()}</span>
		<strong class="state" data-state={status}>{statusText}</strong>
	</p>
	{#if admin}
		<p class="acc-note">{m.conta_2fa_admin_note()}</p>
	{/if}

	{#if enrolment}
		<section class="setup" aria-labelledby="{uid}-scan">
			<h3 id="{uid}-scan" tabindex="-1" use:focusOnMount>{m.conta_2fa_scan_title()}</h3>
			{#if qr}
				<img class="qr" src={qr} alt={m.conta_2fa_qr_alt()} width="200" height="200" />
			{:else}
				<!-- Same 200 × 200 box while the encoder chunk arrives: no layout shift. -->
				<span class="qr qr--pending" aria-hidden="true"></span>
			{/if}
			<p class="acc-hint">{m.conta_2fa_manual_label()}</p>
			<code class="acc-mono key" data-testid="two-factor-key">{key}</code>
			<details>
				<summary>{m.conta_2fa_uri_label()}</summary>
				<code class="acc-mono uri" data-testid="two-factor-uri">{enrolment.totpURI}</code>
			</details>

			<h3 id="{uid}-codes">{m.conta_2fa_codes_title()}</h3>
			<p class="acc-note acc-note--warn">{m.conta_2fa_codes_help()}</p>
			<ul class="codes" aria-labelledby="{uid}-codes">
				{#each enrolment.backupCodes as code, index (index)}
					<li><code class="acc-mono">{code}</code></li>
				{/each}
			</ul>
			<div class="acc-row">
				{#if mounted}
					<Button variant="ghost" size="sm" onclick={copyCodes}>
						{m.conta_2fa_codes_copy()}
					</Button>
				{/if}
				<a class="acc-link" href={codesFile} download="open-auri-recovery-codes.txt">
					{m.conta_2fa_codes_download()}
				</a>
			</div>
			<p class="acc-hint" role="status" aria-live="polite">{copied}</p>
		</section>
	{/if}

	{#if status === 'pending'}
		<form method="POST" action="?/twoFactorConfirm" class="acc-form" use:enhance>
			<h3>{m.conta_2fa_confirm_title()}</h3>
			<Field
				id="{uid}-code"
				label={m.conta_2fa_code_label()}
				hint={m.conta_2fa_code_hint()}
				required
			>
				{#snippet children(control)}
					<input
						{...control}
						class="input acc-mono code"
						name="code"
						type="text"
						inputmode="numeric"
						autocomplete="one-time-code"
						minlength={6}
						maxlength={8}
					/>
				{/snippet}
			</Field>
			<div class="acc-row">
				<Button variant="primary" type="submit">{m.conta_2fa_confirm_submit()}</Button>
			</div>
		</form>
	{/if}

	{#if status === 'off' || (status === 'pending' && !enrolment)}
		<form method="POST" action="?/twoFactorStart" class="acc-form" use:enhance>
			{#if status === 'pending'}
				<p class="acc-hint">{m.conta_2fa_pending_hint()}</p>
			{/if}
			<Field id="{uid}-start-password" label={m.conta_2fa_password()} required>
				{#snippet children(control)}
					<input {...control} name="password" type="password" autocomplete="current-password" />
				{/snippet}
			</Field>
			<div class="acc-row">
				<Button type="submit">
					{status === 'pending' ? m.conta_2fa_restart_submit() : m.conta_2fa_start_submit()}
				</Button>
			</div>
		</form>
	{/if}

	{#if status !== 'off'}
		<form method="POST" action="?/twoFactorDisable" class="acc-form" use:enhance>
			{#if status === 'on'}
				<p class="acc-hint">{m.conta_2fa_disable_help()}</p>
			{/if}
			<Field id="{uid}-disable-password" label={m.conta_2fa_disable_password()} required>
				{#snippet children(control)}
					<input {...control} name="password" type="password" autocomplete="current-password" />
				{/snippet}
			</Field>
			{#if status === 'on'}
				<!-- The second factor too (issue #21): a code from the app or a backup code. Not while
				     a setup is pending: checking a code there would confirm it. -->
				<Field
					id="{uid}-disable-code"
					label={m.conta_2fa_disable_code_label()}
					hint={m.conta_2fa_disable_code_hint()}
					required
				>
					{#snippet children(control)}
						<input
							{...control}
							class="input acc-mono"
							name="code"
							type="text"
							autocomplete="one-time-code"
							autocapitalize="off"
							spellcheck={false}
							maxlength={32}
						/>
					{/snippet}
				</Field>
			{/if}
			<div class="acc-row">
				<Button variant={status === 'on' ? 'danger' : 'ghost'} type="submit">
					{status === 'on' ? m.conta_2fa_disable_submit() : m.conta_2fa_cancel_submit()}
				</Button>
			</div>
		</form>
	{/if}

	<!-- The live regions of Feedback.svelte (always mounted, so changes are announced), plus the
	     disable refusal's own wording: one message for a wrong password or a wrong code, so the
	     answer never says which factor failed. -->
	<div class="feedback" role="status" aria-live="polite">
		{#if mine?.ok}<p class="ok">{feedbackMessage(mine)}</p>{/if}
	</div>
	<div class="feedback" role="alert">
		{#if mine && !mine.ok}
			<p class="error">
				{mine.error === 'wrong-password-or-code'
					? m.conta_2fa_error_disable()
					: feedbackMessage(mine)}
			</p>
		{/if}
	</div>
</div>

<style>
	.feedback p {
		margin: 0;
		font: 13px/1.5 var(--ui, 'Geist', system-ui, sans-serif);
	}

	.feedback .ok {
		color: #9fdcb8;
	}

	.feedback .error {
		color: #ffb4a8;
	}

	.tf,
	.setup {
		display: grid;
		gap: var(--space-3, 12px);
	}

	.setup {
		padding: var(--space-4, 16px);
		border: 1px solid var(--line, #2c2a26);
		border-radius: 6px;
	}

	.status {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 8px;
		margin: 0;
	}

	.state {
		font: 600 13px/1.5 var(--ui, 'Geist', system-ui, sans-serif);
	}

	.state[data-state='on'] {
		color: #9fdcb8;
	}

	.state[data-state='pending'] {
		color: #f2cf7e;
	}

	h3 {
		margin: 0;
		color: var(--text, #ece7dd);
		font: 600 14px/1.4 var(--ui, 'Geist', system-ui, sans-serif);
	}

	h3:focus-visible,
	.status:focus-visible {
		outline: 2px solid var(--accent, #e8b04a);
		outline-offset: 2px;
	}

	.qr {
		width: 200px;
		height: 200px;
		background: #ffffff;
		image-rendering: pixelated;
	}

	.qr--pending {
		display: inline-block;
		vertical-align: baseline;
	}

	.key {
		font-size: 15px;
		letter-spacing: 0.06em;
		word-break: break-all;
	}

	.uri {
		display: block;
		margin-top: 6px;
		word-break: break-all;
	}

	summary {
		cursor: pointer;
		color: var(--state-text, #b5afa4);
		font: 13px/1.5 var(--ui, 'Geist', system-ui, sans-serif);
	}

	.codes {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
		gap: 6px 16px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.code {
		max-width: 12ch;
		letter-spacing: 0.12em;
	}
</style>
