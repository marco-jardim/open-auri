<!-- One labelled input of an auth form, styled as a recessed well on the channel strip. -->
<script lang="ts">
	import { onMount } from 'svelte';
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { m } from '#lib/paraglide/messages.js';
	import { issueMessage } from './messages.ts';
	import type { FieldIssue } from './types.ts';

	interface Props {
		name: string;
		label: string;
		type?: 'email' | 'password' | 'text';
		value?: string;
		autocomplete?: HTMLInputAttributes['autocomplete'];
		inputmode?: HTMLInputAttributes['inputmode'];
		issue?: FieldIssue | undefined;
		hint?: string;
		required?: boolean;
		minlength?: number;
		maxlength?: number;
		/** Extra ids for aria-describedby (e.g. the strength meter). */
		describedby?: string;
		/** Offers a "show password" toggle (enhanced only; needs JS). */
		revealable?: boolean;
	}

	let {
		name,
		label,
		type = 'text',
		value = $bindable(''),
		autocomplete,
		inputmode,
		issue,
		hint,
		required = true,
		minlength,
		maxlength,
		describedby,
		revealable = type === 'password'
	}: Props = $props();

	const id = $props.id();
	let mounted = $state(false);
	let revealed = $state(false);
	const inputType = $derived(type === 'password' && revealed ? 'text' : type);
	const described = $derived(
		[hint ? `${id}-hint` : null, issue ? `${id}-issue` : null, describedby ?? null]
			.filter((part): part is string => part !== null)
			.join(' ')
	);

	onMount(() => {
		mounted = true;
	});
</script>

<div class="field" class:invalid={issue !== undefined}>
	<label for={id}>{label}</label>
	<div class="well">
		<input
			{id}
			{name}
			type={inputType}
			bind:value
			{autocomplete}
			{inputmode}
			{required}
			{minlength}
			{maxlength}
			autocapitalize="none"
			spellcheck="false"
			aria-invalid={issue ? 'true' : undefined}
			aria-describedby={described || undefined}
		/>
		{#if revealable && mounted}
			<button
				type="button"
				class="reveal"
				aria-controls={id}
				aria-pressed={revealed}
				onclick={() => (revealed = !revealed)}
			>
				{m.auth_show_password()}
			</button>
		{/if}
	</div>
	{#if hint}<p class="hint" id="{id}-hint">{hint}</p>{/if}
	{#if issue}<p class="issue" id="{id}-issue">{issueMessage(issue)}</p>{/if}
</div>

<style>
	.field {
		display: grid;
		gap: 6px;
		margin-top: 14px;
	}

	label {
		font: 600 12px/1.3 var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--strip-text, #e3e7ec);
	}

	.well {
		display: flex;
		align-items: stretch;
		border: 1px solid #3a4552;
		border-radius: var(--rad-sm, 3px);
		background: var(--strip-well, #0e1115);
		box-shadow: inset 0 2px 4px rgb(0 0 0 / 55%);
	}

	.invalid .well {
		border-color: var(--lamp-bad, #ff6b5e);
	}

	.well:focus-within {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	input {
		flex: 1;
		min-width: 0;
		min-height: 44px;
		padding: 10px 12px;
		border: 0;
		background: transparent;
		color: var(--strip-text, #e3e7ec);
		font: 15px/1.3 var(--mono, 'JetBrains Mono', monospace);
	}

	input:focus-visible {
		outline: none;
	}

	.reveal {
		flex: none;
		min-width: 44px;
		padding: 0 12px;
		border: 0;
		border-left: 1px solid #3a4552;
		background: transparent;
		color: var(--strip-muted, #a9b2bd);
		font: 600 11px/1 var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.12em;
		text-transform: uppercase;
		cursor: pointer;
	}

	.reveal[aria-pressed='true'] {
		color: var(--accent);
	}

	.reveal:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.hint {
		margin: 0;
		font-size: 12px;
		color: var(--strip-muted, #a9b2bd);
	}

	.issue {
		margin: 0;
		font-size: 12.5px;
		color: #ffb4a8;
	}
</style>
