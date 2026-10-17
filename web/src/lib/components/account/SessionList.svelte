<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { Button } from '#lib/components/primitives/index.ts';
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
		/**
		 * A revocation is on its way and the list is being reloaded (real round trip, set by the
		 * page): the rows turn into skeletons of the same height until the fresh list arrives.
		 */
		pending?: boolean;
	}

	let { sessions, feedback = null, enhance = noEnhance, pending = false }: Props = $props();

	const mine = $derived(feedbackFor(feedback, 'sessions'));
	const others = $derived(sessions.filter((session) => !session.current).length);
</script>

<div class="sessions">
	<!-- While pending, the real rows stay in place (same geometry, CLS zero, the submitting form
	     is not torn down) but are hidden and inert under skeleton bars. -->
	<ul
		class="list"
		class:pending
		aria-busy={pending ? 'true' : undefined}
		inert={pending}
		data-skeleton={pending ? '' : undefined}
	>
		{#each sessions as session (session.id)}
			<li class="item" class:current={session.current}>
				{#if pending}<span class="skeleton row-skeleton" aria-hidden="true"></span>{/if}
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
						<Button
							variant="ghost"
							size="sm"
							type="submit"
							aria-label={m.conta_sessions_revoke_aria({ device: deviceLabel(session) })}
						>
							{m.conta_sessions_revoke()}
						</Button>
					</form>
				{/if}
			</li>
		{/each}
	</ul>
	<!-- Always mounted, so the change of text is announced. -->
	<p class="sr-only" role="status">{pending ? m.fuxp8_sessions_loading() : ''}</p>
	<form method="POST" action="?/revokeOthers" class="acc-row" use:enhance>
		<Button
			type="submit"
			loading={pending}
			disabledReason={others === 0 ? m.conta_sessions_none_other() : null}
		>
			{m.conta_sessions_revoke_others()}
		</Button>
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
		position: relative;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px 16px;
		padding: 12px 0;
		border-bottom: 1px solid var(--rule, rgba(236, 231, 221, 0.12));
	}

	.info {
		display: grid;
		gap: 2px;
		min-width: 0;
	}

	/* Skeleton over the row's own box: the row keeps its real height while hidden. */
	.pending .item > .info,
	.pending .item > form {
		visibility: hidden;
	}

	.row-skeleton {
		position: absolute;
		inset: 12px 0;
		width: auto;
		height: auto;
	}

	.device {
		margin: 0;
		color: var(--text, #ece7dd);
		font-family: var(--face-body, var(--ui, 'Geist', system-ui, sans-serif));
		font-size: var(--fs-small, 13px);
		font-weight: 600;
		line-height: 1.5;
	}

	.tag {
		margin-left: 8px;
		padding: 1px 6px;
		border: 1px solid var(--pop-rule, #34332f);
		border-radius: var(--rad-xs, 2px);
		color: var(--state-text, #b5afa4);
		font-family: var(--face-data, var(--mono, 'JetBrains Mono', monospace));
		font-size: var(--label-min, 11px);
		font-weight: 500;
		line-height: 1.4;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.tag--warn {
		border-color: var(--warn, #f2b33d);
		color: var(--warn, #f2b33d);
	}
</style>
