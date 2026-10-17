<!--
	Turnstile on an auth form, at the EQ stage of the channel strip. The token travels as the
	`cf-turnstile-response` form field; the action forwards it in the `x-turnstile-token` header.
	Tokens are single use: `resetKey` changes after every enhanced submission so the widget renders
	again with a fresh token. Each render owns its own token slot, so a new widget never starts
	with the token of the previous one. Without a site key (tests, misconfiguration) only the empty
	field is rendered and the server refuses the attempt with the uniform "security check" message.
	The EQ lamp lights only while a token is present (real widget state).
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { Lamp } from '#lib/components/primitives/index.ts';
	import Turnstile from '#lib/components/security/Turnstile.svelte';
	import { stageLabel, trackStage } from './AuthShell.svelte';
	import { TURNSTILE_FIELD } from './fields.ts';

	interface Props {
		siteKey: string;
		/** TURNSTILE_ACTIONS value checked by the server for this form. */
		action: string;
		resetKey?: number;
	}

	let { siteKey, action, resetKey = 0 }: Props = $props();
	/** Token of each widget render, keyed by resetKey (read only for the lamp). */
	const tokens = $state<Record<number, string>>({});
	const solved = $derived(Boolean(tokens[resetKey]));

	trackStage(() => solved);
</script>

<div class="human-check stage-host">
	<span class="stage" data-stage="eq" data-on={solved} aria-hidden="true">
		<svg class="stage__knob" viewBox="0 0 22 22" focusable="false">
			<circle cx="11" cy="11" r="9.5" fill="#2a313b" stroke="currentColor" stroke-opacity="0.6" />
			<circle cx="11" cy="11" r="6" fill="#323a45" />
			<line
				class="pointer"
				x1="11"
				y1="11"
				x2="11"
				y2="3"
				stroke="#e3e7ec"
				stroke-width="2"
				stroke-linecap="round"
			/>
		</svg>
		<span class="stage__name">{stageLabel('eq')}</span>
		<Lamp on={solved} tone="ok" />
	</span>
	{#if siteKey}
		{#key resetKey}
			<Turnstile
				{siteKey}
				{action}
				name={TURNSTILE_FIELD}
				theme="dark"
				language={getLocale().toLowerCase()}
				bind:token={() => tokens[resetKey] ?? '', (token) => (tokens[resetKey] = token)}
			/>
		{/key}
	{:else}
		<input type="hidden" name={TURNSTILE_FIELD} value="" />
	{/if}
	<noscript><p class="noscript">{m.auth_turnstile_noscript()}</p></noscript>
</div>

<style>
	.human-check {
		margin-top: 16px;
	}

	.noscript {
		margin: 6px 0 0;
		font-size: var(--fs-caption, 12px);
		color: #ffd1ca;
	}
</style>
