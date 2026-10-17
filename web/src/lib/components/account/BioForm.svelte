<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { Button, Field } from '#lib/components/primitives/index.ts';
	import Feedback from './Feedback.svelte';
	import { feedbackFor, noEnhance, type FormEnhance, type FormFeedback } from './types.ts';
	import './account.css';

	interface Props {
		bio: string | null;
		emailVerified: boolean;
		max?: number;
		feedback?: FormFeedback | null;
		enhance?: FormEnhance;
	}

	let { bio, emailVerified, max = 280, feedback = null, enhance = noEnhance }: Props = $props();

	const uid = $props.id();
	const mine = $derived(feedbackFor(feedback, 'bio'));
	// Seeded from the server value; the textarea owns it while the user types.
	let text = $state('');
	let seeded = $state<string | null | undefined>(undefined);
	$effect.pre(() => {
		const source = mine && !mine.ok && mine.value !== undefined ? mine.value : (bio ?? '');
		if (seeded !== source) {
			seeded = source;
			text = source;
		}
	});
	// Code points, like the server and SQLite length().
	const used = $derived([...text].length);
	const over = $derived(used > max);
	const reason = $derived(
		!emailVerified
			? m.conta_error_unverified()
			: over
				? m.fuxp8_bio_over({ max: String(max) })
				: null
	);
</script>

<form method="POST" action="?/bio" class="acc-form" use:enhance>
	<div class="acc-field">
		<!-- Hint and live count share one row under the field, so they stay outside Field. -->
		<Field id="{uid}-bio" label={m.conta_bio_label()}>
			{#snippet children(control)}
				<textarea
					{...control}
					class="input bio"
					name="bio"
					rows="4"
					disabled={!emailVerified}
					bind:value={text}
					aria-describedby="{uid}-hint {uid}-count"
					aria-invalid={over ? 'true' : undefined}></textarea>
			{/snippet}
		</Field>
		<div class="acc-row meta">
			<p class="acc-hint" id="{uid}-hint">{m.conta_bio_hint()}</p>
			<p class="acc-hint count" class:over id="{uid}-count" aria-live="polite">
				{m.conta_bio_count({ used: String(used), max: String(max) })}
			</p>
		</div>
	</div>
	<div class="acc-row">
		<Button type="submit" disabledReason={reason}>
			{m.conta_bio_submit()}
		</Button>
	</div>
	<Feedback feedback={mine} />
</form>

<style>
	.bio {
		min-height: 110px;
		resize: vertical;
		font-size: var(--fs-body, 15px);
		line-height: var(--lh-body, 1.55);
	}

	.meta {
		justify-content: space-between;
	}

	.count {
		font-family: var(--face-data, var(--mono, 'JetBrains Mono', monospace));
		font-variant-numeric: tabular-nums slashed-zero;
	}

	.over {
		color: #ffb4a8;
	}
</style>
