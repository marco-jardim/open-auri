<script lang="ts">
	import { feedbackMessage } from './format.ts';
	import type { FormFeedback } from './types.ts';

	interface Props {
		feedback: FormFeedback | null;
	}

	let { feedback }: Props = $props();
</script>

<!-- Live regions stay mounted so screen readers announce the change. -->
<div class="feedback" role="status" aria-live="polite">
	{#if feedback?.ok}<p class="ok">{feedbackMessage(feedback)}</p>{/if}
</div>
<div class="feedback" role="alert">
	{#if feedback && !feedback.ok}<p class="error">{feedbackMessage(feedback)}</p>{/if}
</div>

<style>
	p {
		margin: 0;
		font: 13px/1.5 var(--ui, 'Geist', system-ui, sans-serif);
	}

	.ok {
		color: #9fdcb8;
	}

	.error {
		color: #ffb4a8;
	}
</style>
