<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
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
</script>

<form method="POST" action="?/bio" class="acc-form" use:enhance>
	<div class="acc-field">
		<label class="acc-label" for="{uid}-bio">{m.conta_bio_label()}</label>
		<textarea
			id="{uid}-bio"
			class="acc-textarea"
			name="bio"
			rows="4"
			disabled={!emailVerified}
			bind:value={text}
			aria-describedby="{uid}-hint {uid}-count"
			aria-invalid={over ? 'true' : undefined}></textarea>
		<div class="acc-row meta">
			<p class="acc-hint" id="{uid}-hint">{m.conta_bio_hint()}</p>
			<p class="acc-hint count" class:over id="{uid}-count" aria-live="polite">
				{m.conta_bio_count({ used: String(used), max: String(max) })}
			</p>
		</div>
	</div>
	<div class="acc-row">
		<button class="acc-btn" type="submit" disabled={!emailVerified || over}>
			{m.conta_bio_submit()}
		</button>
	</div>
	<Feedback feedback={mine} />
</form>

<style>
	.meta {
		justify-content: space-between;
	}

	.count {
		font-family: var(--mono, 'JetBrains Mono', monospace);
	}

	.over {
		color: #ffb4a8;
	}
</style>
