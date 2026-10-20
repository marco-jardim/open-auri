<script lang="ts">
	import { PUBLIC_TURNSTILE_SITE_KEY } from '$app/env/public';
	import { enhance } from '$app/forms';
	import {
		BioForm,
		CloseAccountForm,
		EmailForm,
		ExportForm,
		NicknameForm,
		PasswordForm,
		Section,
		SessionList,
		TwoFactorForm,
		VisibilityForm,
		type FormEnhance,
		type FormFeedback
	} from '#lib/components/account/index.ts';
	import PolicyBanner from '#lib/components/legal/PolicyBanner.svelte';
	import LazyArt from '#lib/components/art/LazyArt.svelte';
	import { m } from '#lib/paraglide/messages.js';
	import type { PageProps } from './$types';
	import HiddenItems from '#lib/components/social/HiddenItems.svelte';

	let { data, form }: PageProps = $props();

	const feedback = $derived((form ?? null) as FormFeedback | null);
	const profile = $derived(data.profile);

	// Profile forms keep what the user typed after saving (no form reset).
	const keep: FormEnhance = (node) =>
		enhance(node, () => async ({ update }) => {
			await update({ reset: false });
		});
	const plain: FormEnhance = (node) => enhance(node);

	// Session revocations: same enhance as `plain`, plus the real round trip drives the list's
	// skeleton (pending from submit until the reloaded list is in).
	let sessionsPending = $state(false);
	const sessionsEnhance: FormEnhance = (node) =>
		enhance(node, () => {
			sessionsPending = true;
			return async ({ update }) => {
				try {
					await update();
				} finally {
					sessionsPending = false;
				}
			};
		});

	async function acceptPolicy(version: string): Promise<void> {
		const response = await fetch('/conta/politica', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ version })
		});
		if (!response.ok) throw new Error(`policy acceptance failed: ${response.status}`);
	}

	const sections = [
		{ id: 'perfil', label: () => m.conta_nav_profile() },
		{ id: 'seguranca', label: () => m.conta_nav_security() },
		{ id: 'duas-etapas', label: () => m.conta_2fa_nav() },
		{ id: 'email', label: () => m.conta_nav_email() },
		{ id: 'dados', label: () => m.conta_nav_data() },
		{ id: 'itens-ocultos', label: () => m.hidden_title() },
		{ id: 'encerrar', label: () => m.conta_nav_close() }
	];
</script>

<svelte:head>
	<title>{m.conta_title()} · open-auri</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="account">
	<LazyArt
		load={() => import('#lib/components/art/AuthArt.svelte')}
		props={{ variant: 'account' }}
	/>
	<PolicyBanner
		version={data.policy.version}
		seenVersion={data.policy.seenVersion}
		onAccept={acceptPolicy}
	/>

	<header class="head">
		<p class="eyebrow">{m.conta_eyebrow()}</p>
		<h1>{m.conta_title()}</h1>
		<p class="lede">
			{#if profile.displayUsername}
				{m.conta_lede_named({ nickname: profile.displayUsername })}
			{:else}
				{m.conta_lede()}
			{/if}
		</p>
		<nav aria-label={m.conta_nav_label()}>
			<ul>
				{#each sections as section (section.id)}
					<li><a class="acc-link" href="#{section.id}">{section.label()}</a></li>
				{/each}
			</ul>
		</nav>
	</header>

	{#if !profile.emailVerified}
		<p class="acc-note acc-note--warn">{m.conta_unverified_notice()}</p>
	{/if}

	<Section id="perfil" title={m.conta_profile_title()} description={m.conta_profile_description()}>
		<NicknameForm
			current={profile.displayUsername}
			emailVerified={profile.emailVerified}
			nextChangeAt={profile.nextNicknameChangeAt}
			holds={data.holds}
			min={data.limits.nicknameMin}
			max={data.limits.nicknameMax}
			{feedback}
			enhance={keep}
		/>
		<BioForm
			bio={profile.bio}
			emailVerified={profile.emailVerified}
			max={data.limits.bioMax}
			{feedback}
			enhance={keep}
		/>
		<VisibilityForm
			library={profile.libraryVisibility}
			activity={profile.activityVisibility}
			emailVerified={profile.emailVerified}
			{feedback}
			enhance={keep}
		/>
	</Section>

	<Section
		id="seguranca"
		title={m.conta_security_title()}
		description={m.conta_security_description()}
	>
		<div class="sub">
			<h3>{m.conta_password_title()}</h3>
			<PasswordForm
				min={data.limits.passwordMin}
				max={data.limits.passwordMax}
				{feedback}
				enhance={plain}
			/>
		</div>
		<div class="sub">
			<h3>{m.conta_sessions_title()}</h3>
			<p class="acc-hint">{m.conta_sessions_description()}</p>
			<SessionList
				sessions={data.sessions}
				{feedback}
				enhance={sessionsEnhance}
				pending={sessionsPending}
			/>
		</div>
	</Section>

	<Section id="duas-etapas" title={m.conta_2fa_title()} description={m.conta_2fa_description()}>
		<TwoFactorForm
			status={data.twoFactor.status}
			admin={data.twoFactor.admin}
			feedback={feedback ?? data.twoFactorNotice}
			enhance={plain}
		/>
	</Section>

	<Section id="email" title={m.conta_email_title()} description={m.conta_email_description()}>
		<EmailForm
			email={profile.email}
			pending={data.pendingEmail}
			fresh={data.fresh}
			siteKey={PUBLIC_TURNSTILE_SITE_KEY}
			turnstileAction={data.turnstileAction}
			changed={data.emailChanged}
			{feedback}
			enhance={plain}
		/>
	</Section>

	<Section id="dados" title={m.conta_export_title()} description={m.conta_export_description()}>
		<ExportForm />
	</Section>
	<HiddenItems />

	<Section
		id="encerrar"
		title={m.conta_close_title()}
		description={m.conta_close_description()}
		tone="danger"
	>
		<CloseAccountForm pending={data.closure} {feedback} enhance={plain} />
	</Section>
</div>

<style>
	.account {
		/* Holds the background line art (AuthArt) under the sections. */
		position: relative;
		isolation: isolate;
		display: grid;
		gap: var(--space-5, 24px);
		width: min(100%, 860px);
		margin: 0 auto;
		padding: var(--space-6, 32px) var(--gutter, 24px) var(--space-8, 80px);
		color: var(--text, #ece7dd);
	}

	.head {
		display: grid;
		gap: var(--space-2, 8px);
	}

	/* Type from the v2.1 scale (spec §2.1): mono at 500 at most, display serif for the title. */
	.eyebrow {
		margin: 0;
		color: var(--muted, #8f8a80);
		font-family: var(--face-data, var(--mono, 'JetBrains Mono', monospace));
		font-size: var(--fs-eyebrow, 11px);
		font-weight: 500;
		line-height: var(--lh-caps, 1.35);
		letter-spacing: var(--tracking-eyebrow, 0.18em);
		text-transform: uppercase;
	}

	h1 {
		margin: 0;
		font-family: var(--face-display, var(--serif, 'Instrument Serif', Georgia, serif));
		font-size: var(--fs-display-m, 44px);
		font-weight: 400;
		line-height: 1;
		letter-spacing: -0.015em;
	}

	.lede {
		margin: 0;
		color: var(--state-text, #b5afa4);
		font-family: var(--face-body, var(--ui, 'Geist', system-ui, sans-serif));
		font-size: var(--fs-lede, 16px);
		line-height: 1.5;
	}

	nav ul {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 18px;
		margin: var(--space-2, 8px) 0 0;
		padding: 0;
		list-style: none;
		font-family: var(--face-body, var(--ui, 'Geist', system-ui, sans-serif));
		font-size: var(--fs-small, 13px);
		line-height: 1.5;
	}

	.sub {
		display: grid;
		gap: var(--space-3, 12px);
	}

	h3 {
		margin: 0;
		color: var(--text, #ece7dd);
		font-family: var(--face-body, var(--ui, 'Geist', system-ui, sans-serif));
		font-size: var(--fs-ui, 14px);
		font-weight: 600;
		line-height: 1.4;
	}
</style>
