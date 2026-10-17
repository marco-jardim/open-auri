<!--
	One labelled input of an auth form: the Field primitive (label, hint, error with icon and
	aria-invalid) set into a recessed well, hung on a stage of the channel strip (AuthShell).
	The stage lamp lights only from real validation state: the field has a value, the browser's
	constraint validation passes (type, required, minlength, maxlength), the confirmation matches
	when `mustMatch` is given, and the value is not the one the server just refused.
-->
<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { m } from '#lib/paraglide/messages.js';
	import { Button, Field, Lamp } from '#lib/components/primitives/index.ts';
	import { stageLabel, trackStage, type StageId } from './AuthShell.svelte';
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
		/**
		 * Stage of the channel strip: `input` for the identity (e-mail, code), `gain` for the
		 * secret. Defaults from the type; null renders no stage.
		 */
		stage?: StageId | null;
		/** The value this field must repeat (password confirmation); lamp only, the server decides. */
		mustMatch?: string;
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
		revealable = type === 'password',
		stage = type === 'password' ? 'gain' : 'input',
		mustMatch
	}: Props = $props();

	const id = $props.id();
	let input = $state<HTMLInputElement>();
	let mounted = $state(false);
	let revealed = $state(false);
	let nativeValid = $state(false);
	/** The value the server refused (its issue stays until the user changes it). */
	let refused = $derived<string | null>(issue === undefined ? null : untrack(() => value));
	const inputType = $derived(type === 'password' && revealed ? 'text' : type);
	const error = $derived(issue ? issueMessage(issue) : null);
	// The refused clause comes first on purpose: `refused` is a lazy derived that captures the
	// value when it is first read after the issue changes. Read first, it is evaluated in the same
	// flush in which the issue arrives (the template reads `ok`), so it holds the value the server
	// refused. Behind the other clauses it could be skipped by their short-circuit (not mounted,
	// natively invalid) and first read only after the user typed, capturing the wrong value.
	const ok = $derived(
		(issue === undefined || value !== refused) &&
			mounted &&
			value !== '' &&
			nativeValid &&
			(mustMatch === undefined || value === mustMatch)
	);

	// Constraint validation is not reactive: read it again whenever the value or type changes.
	$effect(() => {
		void value;
		void inputType;
		nativeValid = input?.validity.valid ?? false;
	});

	trackStage(() => (stage ? ok : null));

	onMount(() => {
		mounted = true;
	});

	function describedBy(own: string | undefined): string | undefined {
		return [own, describedby].filter(Boolean).join(' ') || undefined;
	}
</script>

<div class="auth-field stage-host">
	{#if stage}
		<span class="stage" data-stage={stage} data-on={ok} aria-hidden="true">
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
			<span class="stage__name">{stageLabel(stage)}</span>
			<Lamp on={ok} tone="ok" />
		</span>
	{/if}
	<Field {label} {hint} {error} {required} {id}>
		{#snippet children(control)}
			<input
				{...control}
				bind:this={input}
				class="input auth-input"
				{name}
				type={inputType}
				bind:value
				{autocomplete}
				{inputmode}
				{minlength}
				{maxlength}
				autocapitalize="none"
				spellcheck="false"
				aria-describedby={describedBy(control['aria-describedby'])}
			/>
			{#if revealable && mounted}
				<Button
					variant="plate"
					class="reveal"
					aria-controls={id}
					aria-pressed={revealed}
					onclick={() => (revealed = !revealed)}
				>
					{m.auth_show_password()}
				</Button>
			{/if}
		{/snippet}
	</Field>
</div>

<style>
	.auth-field {
		margin-top: 14px;
	}

	.auth-field :global(.field__label) {
		color: var(--strip-text, #e3e7ec);
		font-family: var(--face-engrave, var(--cond, 'Barlow Condensed', sans-serif));
		font-size: var(--fs-caption, 12px);
		font-weight: 600;
		letter-spacing: var(--tracking-caps, 0.14em);
		line-height: var(--lh-caps, 1.35);
		text-transform: uppercase;
	}

	.auth-field :global(.field__hint) {
		color: var(--strip-muted, #a9b2bd);
	}

	.auth-field :global(.field__error) {
		color: #ffb4a8;
	}

	.auth-field :global(.field__control) {
		gap: 6px;
	}

	/* The input sits in a recessed well on the painted panel. */
	.auth-field :global(.auth-input) {
		min-height: 44px;
		background: var(--strip-well, #0e1115);
		box-shadow: var(--well, inset 0 2px 4px rgb(0 0 0 / 55%));
		color: var(--strip-text, #e3e7ec);
		font-size: var(--fs-body, 15px);
	}

	.auth-field :global(.auth-input[aria-invalid='true']) {
		border-color: var(--lamp-bad, #ff6b5e);
	}

	.auth-field :global(.reveal) {
		flex: none;
		min-height: 44px;
	}

	.auth-field :global(.reveal[aria-pressed='true']) {
		color: var(--accent-text, var(--accent));
	}
</style>
