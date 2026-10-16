<!--
	Resend the verification link, with the visible wait the server rule imposes (one send per
	RESEND_COOLDOWN_SECONDS; the server limit is 3 per 300 s). The wait comes from the server
	(cookie timestamp), so it survives reloads and also works without JavaScript: without JS the
	button stays enabled and an early click gets the same wait message from the server.
-->
<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import AuthField from './AuthField.svelte';
	import FormAlert from './FormAlert.svelte';
	import SubmitSwitch from './SubmitSwitch.svelte';
	import { FormController } from './form-controller.svelte.ts';
	import { errorMessage, formatWait } from './messages.ts';
	import type { AuthFormState } from './types.ts';
	import type { FormEnhancer } from './enhancer-types.ts';

	interface Props {
		result?: AuthFormState | null;
		next?: string | null;
		/** Epoch ms when the next send is allowed (from the page load), or null. */
		availableAt?: number | null;
		/** Clock (tests pass a fake one). */
		now?: () => number;
		enhancer?: FormEnhancer;
	}

	let {
		result = null,
		next = null,
		availableAt = null,
		now = () => Date.now(),
		enhancer
	}: Props = $props();
	const controller = new FormController(() => enhancer);
	const uid = $props.id();
	let email = $state(untrack(() => result?.values?.email ?? ''));
	let clock = $state(untrack(() => now()));
	let hydrated = $state(false);
	const target = $derived(result?.resendAvailableAt ?? availableAt);
	const remaining = $derived(target ? Math.max(0, Math.ceil((target - clock) / 1000)) : 0);
	const waiting = $derived(remaining > 0);

	onMount(() => {
		hydrated = true;
	});

	$effect(() => {
		const until = target;
		const read = now;
		if (!until) return;
		clock = read();
		const timer = setInterval(() => {
			clock = read();
			if (clock >= until) clearInterval(timer);
		}, 1000);
		return () => clearInterval(timer);
	});
</script>

<form method="POST" use:controller.enhance aria-labelledby="{uid}-title">
	<h2 id="{uid}-title" class="section-title">{m.auth_verify_resend_title()}</h2>
	{#if result?.sent}
		<FormAlert tone="ok" message={m.auth_verify_resend_done()} />
	{:else if result?.error && result.error !== 'cooldown'}
		<FormAlert message={errorMessage(result.error, result.retryAfter)} />
	{/if}
	{#if next}<input type="hidden" name="next" value={next} />{/if}
	<AuthField
		name="email"
		type="email"
		label={m.auth_field_email()}
		autocomplete="email"
		inputmode="email"
		maxlength={254}
		bind:value={email}
		issue={result?.fields?.email}
	/>
	{#if waiting}
		<p class="wait" id="{uid}-wait" data-remaining={remaining}>
			<span class="lamp" aria-hidden="true"></span>
			{result?.error === 'cooldown'
				? errorMessage('cooldown', remaining)
				: m.auth_verify_wait({ time: formatWait(remaining) })}
		</p>
	{/if}
	<p class="sr-only" aria-live="polite">{target && !waiting ? m.auth_verify_ready() : ''}</p>
	<SubmitSwitch
		label={m.auth_verify_resend_submit()}
		busyLabel={m.auth_verify_resend_busy()}
		busy={controller.busy}
		disabled={hydrated && waiting}
	/>
</form>

<style>
	.section-title {
		margin: 18px 0 0;
		font: 600 14px/1.3 var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.16em;
		text-transform: uppercase;
	}

	.wait {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 12px 0 0;
		font: 13px/1.4 var(--mono, 'JetBrains Mono', monospace);
		font-variant-numeric: tabular-nums;
		color: var(--strip-text, #e3e7ec);
	}

	.lamp {
		flex: none;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--lamp-warn, #f2b33d);
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
