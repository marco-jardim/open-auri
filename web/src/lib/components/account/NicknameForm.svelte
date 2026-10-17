<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import Button from '#lib/components/primitives/Button.svelte';
	import Field from '#lib/components/primitives/Field.svelte';
	import Feedback from './Feedback.svelte';
	import { formatDate } from './format.ts';
	import {
		feedbackFor,
		noEnhance,
		type FormEnhance,
		type FormFeedback,
		type HoldView
	} from './types.ts';
	import './account.css';

	interface Props {
		current: string | null;
		emailVerified: boolean;
		/** Epoch ms when a change is allowed again; null when allowed now. */
		nextChangeAt: number | null;
		holds?: HoldView[];
		min?: number;
		max?: number;
		feedback?: FormFeedback | null;
		enhance?: FormEnhance;
	}

	let {
		current,
		emailVerified,
		nextChangeAt,
		holds = [],
		min = 3,
		max = 24,
		feedback = null,
		enhance = noEnhance
	}: Props = $props();

	const uid = $props.id();
	const mine = $derived(feedbackFor(feedback, 'nickname'));
	const first = $derived(current === null);
	const waiting = $derived(!first && nextChangeAt !== null);
</script>

<form method="POST" action="?/nickname" class="acc-form" use:enhance>
	{#if first}
		<p class="acc-note acc-note--warn">{m.conta_nickname_first()}</p>
	{/if}
	<div class="acc-field">
		<!-- The server's answer is announced by Feedback; the field only carries aria-invalid. -->
		<Field
			id="{uid}-nickname"
			label={m.conta_nickname_label()}
			hint={m.conta_nickname_rules({ min: String(min), max: String(max) })}
			required
		>
			{#snippet children(control)}
				<input
					{...control}
					class="input acc-mono"
					name="nickname"
					type="text"
					autocomplete="username"
					autocapitalize="none"
					spellcheck="false"
					minlength={min}
					maxlength={max}
					disabled={!emailVerified}
					value={mine?.value ?? current ?? ''}
					aria-describedby="{control['aria-describedby'] ?? ''} {uid}-clock"
					aria-invalid={mine && !mine.ok ? 'true' : undefined}
				/>
			{/snippet}
		</Field>
		<p class="acc-hint" id="{uid}-clock">
			{#if !emailVerified}
				{m.conta_nickname_needs_verification()}
			{:else if first}
				{m.conta_nickname_clock_first()}
			{:else if waiting && nextChangeAt !== null}
				{m.conta_nickname_clock_wait({ date: formatDate(nextChangeAt) })}
			{:else}
				{m.conta_nickname_clock_now()}
			{/if}
		</p>
	</div>
	{#if holds.length > 0}
		<div class="acc-field">
			<p class="acc-label">{m.conta_nickname_holds_title()}</p>
			<ul class="holds">
				{#each holds as hold (hold.username)}
					<li>
						<span class="acc-mono">{hold.username}</span>
						{m.conta_nickname_hold_until({ date: formatDate(hold.releasedAt) })}
					</li>
				{/each}
			</ul>
		</div>
	{/if}
	<div class="acc-row">
		<Button
			type="submit"
			variant={first ? 'primary' : 'plate'}
			disabledReason={emailVerified ? null : m.conta_error_unverified()}
		>
			{first ? m.conta_nickname_submit_first() : m.conta_nickname_submit()}
		</Button>
	</div>
	<Feedback feedback={mine} />
</form>

<style>
	.holds {
		margin: 0;
		padding: 0 0 0 18px;
		color: var(--state-text, #b5afa4);
		font: 13px/1.6 var(--ui, 'Geist', system-ui, sans-serif);
	}
</style>
