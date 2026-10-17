<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { Button, Field } from '#lib/components/primitives/index.ts';
	import Feedback from './Feedback.svelte';
	import { formatDateTime } from './format.ts';
	import {
		feedbackFor,
		noEnhance,
		type ClosureView,
		type DeletionMode,
		type FormEnhance,
		type FormFeedback
	} from './types.ts';
	import './account.css';

	interface Props {
		/** A closure already requested (link mailed), if any. */
		pending?: ClosureView | null;
		feedback?: FormFeedback | null;
		enhance?: FormEnhance;
	}

	let { pending = null, feedback = null, enhance = noEnhance }: Props = $props();

	const uid = $props.id();
	const mine = $derived(feedbackFor(feedback, 'close'));
	// No preselected mode: the user has to pick one of the two effects.
	let mode = $state<DeletionMode | ''>('');
	const effect = $derived(
		mode === 'anonymize'
			? m.conta_close_effect_anonymize()
			: mode === 'delete-all'
				? m.conta_close_effect_delete()
				: ''
	);
</script>

<form method="POST" action="?/close" class="acc-form" use:enhance>
	{#if pending}
		<p class="acc-note acc-note--warn" data-testid="close-pending">
			{m.conta_close_pending({ date: formatDateTime(pending.requestedAt) })}
		</p>
	{/if}
	<p class="acc-note acc-note--danger">{m.conta_close_always()}</p>
	<fieldset class="modes">
		<legend class="acc-label">{m.conta_close_mode_legend()}</legend>
		<label class="acc-check">
			<input
				type="radio"
				name="mode"
				value="anonymize"
				required
				bind:group={mode}
				aria-describedby="{uid}-anonymize"
			/>
			<span>{m.conta_close_mode_anonymize()}</span>
		</label>
		<p class="acc-hint" id="{uid}-anonymize">{m.conta_close_mode_anonymize_help()}</p>
		<label class="acc-check">
			<input
				type="radio"
				name="mode"
				value="delete-all"
				required
				bind:group={mode}
				aria-describedby="{uid}-delete"
			/>
			<span>{m.conta_close_mode_delete()}</span>
		</label>
		<p class="acc-hint" id="{uid}-delete">{m.conta_close_mode_delete_help()}</p>
	</fieldset>
	{#if effect}<p class="acc-note" aria-live="polite">{effect}</p>{/if}
	<Field id="{uid}-password" label={m.conta_close_password()} required>
		{#snippet children(control)}
			<input {...control} name="password" type="password" autocomplete="current-password" />
		{/snippet}
	</Field>
	<label class="acc-check">
		<input type="checkbox" name="acknowledged" required />
		<span>{m.conta_close_ack()}</span>
	</label>
	<p class="acc-hint">{m.conta_close_how()}</p>
	<div class="acc-row">
		<!-- Not disabled: `required` fields do the checking, also without JavaScript. -->
		<Button variant="danger" type="submit">
			{m.conta_close_submit()}
		</Button>
	</div>
	<Feedback feedback={mine} />
</form>

<style>
	.modes {
		display: grid;
		gap: 6px;
		margin: 0;
		padding: 0;
		border: 0;
	}

	.modes legend {
		margin-bottom: 8px;
		padding: 0;
	}
</style>
