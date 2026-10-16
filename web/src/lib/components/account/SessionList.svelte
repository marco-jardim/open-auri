<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import Feedback from './Feedback.svelte';
	import { deviceLabel, formatDateTime } from './format.ts';
	import {
		feedbackFor,
		noEnhance,
		type FormEnhance,
		type FormFeedback,
		type SessionView
	} from './types.ts';
	import './account.css';

	interface Props {
		sessions: SessionView[];
		feedback?: FormFeedback | null;
		enhance?: FormEnhance;
	}

	let { sessions, feedback = null, enhance = noEnhance }: Props = $props();

	const mine = $derived(feedbackFor(feedback, 'sessions'));
	const others = $derived(sessions.filter((session) => !session.current).length);
</script>

<div class="sessions">
	<ul class="list">
		{#each sessions as session (session.id)}
			<li class="item" class:current={session.current}>
				<div class="info">
					<p class="device">
						{deviceLabel(session)}
						{#if session.current}<span class="tag">{m.conta_sessions_current()}</span>{/if}
						{#if session.impersonated}
							<span class="tag tag--warn">{m.conta_sessions_impersonated()}</span>
						{/if}
					</p>
					<p class="acc-hint">
						{m.conta_sessions_last_active({ date: formatDateTime(session.lastActiveAt) })}
						·
						{m.conta_sessions_started({ date: formatDateTime(session.createdAt) })}
					</p>
				</div>
				{#if !session.current}
					<form method="POST" action="?/revokeSession" use:enhance>
						<input type="hidden" name="sessionId" value={session.id} />
						<button
							class="acc-btn acc-btn--quiet"
							type="submit"
							aria-label={m.conta_sessions_revoke_aria({ device: deviceLabel(session) })}
						>
							{m.conta_sessions_revoke()}
						</button>
					</form>
				{/if}
			</li>
		{/each}
	</ul>
	<form method="POST" action="?/revokeOthers" class="acc-row" use:enhance>
		<button class="acc-btn" type="submit" disabled={others === 0}>
			{m.conta_sessions_revoke_others()}
		</button>
		<p class="acc-hint">
			{others === 0 ? m.conta_sessions_none_other() : m.conta_sessions_revoke_others_help()}
		</p>
	</form>
	<Feedback feedback={mine} />
</div>

<style>
	.sessions {
		display: grid;
		gap: var(--space-3, 12px);
	}

	.list {
		display: grid;
		gap: 0;
		margin: 0;
		padding: 0;
		list-style: none;
		border-top: 1px solid var(--rule, rgba(236, 231, 221, 0.12));
	}

	.item {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px 16px;
		padding: 12px 0;
		border-bottom: 1px solid var(--rule, rgba(236, 231, 221, 0.12));
	}

	.info {
		min-width: 0;
	}

	.device {
		margin: 0 0 2px;
		color: var(--text, #ece7dd);
		font: 600 13px/1.5 var(--ui, 'Geist', system-ui, sans-serif);
	}

	.tag {
		margin-left: 8px;
		padding: 1px 6px;
		border: 1px solid var(--pop-rule, #34332f);
		border-radius: var(--rad-xs, 2px);
		color: var(--state-text, #b5afa4);
		font: 600 10px/1.4 var(--mono, 'JetBrains Mono', monospace);
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.tag--warn {
		border-color: #f2b33d;
		color: #f2b33d;
	}
</style>
