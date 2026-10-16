<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import Feedback from './Feedback.svelte';
	import {
		feedbackFor,
		noEnhance,
		type FormEnhance,
		type FormFeedback,
		type Visibility
	} from './types.ts';
	import './account.css';

	interface Props {
		library: Visibility;
		activity: Visibility;
		emailVerified: boolean;
		feedback?: FormFeedback | null;
		enhance?: FormEnhance;
	}

	let { library, activity, emailVerified, feedback = null, enhance = noEnhance }: Props = $props();

	const uid = $props.id();
	const mine = $derived(feedbackFor(feedback, 'visibility'));
</script>

<form method="POST" action="?/visibility" class="acc-form" use:enhance>
	<p class="acc-note">{m.conta_visibility_default()}</p>
	<div class="acc-field">
		<label class="acc-check">
			<input
				type="checkbox"
				name="library_visibility"
				value="public"
				checked={library === 'public'}
				disabled={!emailVerified}
				aria-describedby="{uid}-library"
			/>
			<span>{m.conta_visibility_library_label()}</span>
		</label>
		<p class="acc-hint" id="{uid}-library">{m.conta_visibility_library_help()}</p>
	</div>
	<div class="acc-field">
		<label class="acc-check">
			<input
				type="checkbox"
				name="activity_visibility"
				value="public"
				checked={activity === 'public'}
				disabled={!emailVerified}
				aria-describedby="{uid}-activity"
			/>
			<span>{m.conta_visibility_activity_label()}</span>
		</label>
		<p class="acc-hint" id="{uid}-activity">{m.conta_visibility_activity_help()}</p>
	</div>
	<p class="acc-hint">{m.conta_visibility_always()}</p>
	<div class="acc-row">
		<button class="acc-btn" type="submit" disabled={!emailVerified}>
			{m.conta_visibility_submit()}
		</button>
	</div>
	<Feedback feedback={mine} />
</form>
