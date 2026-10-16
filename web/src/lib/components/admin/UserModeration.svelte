<script lang="ts">
	// Ban (reason + validity) or unban (reason) form for one user row. Native <details> keeps it
	// keyboard-accessible and working without JavaScript; `use:enhance` upgrades it when present.
	import { enhance } from '$app/forms';
	import { m } from '#lib/paraglide/messages.js';

	let { userId, banned, label }: { userId: string; banned: boolean; label: string } = $props();
	const id = $props.id();

	const durations = $derived([
		{ value: '1', text: m.admin_duration_1() },
		{ value: '7', text: m.admin_duration_7() },
		{ value: '30', text: m.admin_duration_30() },
		{ value: '90', text: m.admin_duration_90() },
		{ value: '365', text: m.admin_duration_365() },
		{ value: 'permanent', text: m.admin_duration_permanent() }
	]);
</script>

<details>
	<summary>
		{banned ? m.admin_unban_summary({ user: label }) : m.admin_ban_summary({ user: label })}
	</summary>
	{#if banned}
		<form method="POST" action="?/unban" use:enhance>
			<input type="hidden" name="userId" value={userId} />
			<label for="{id}-reason">{m.admin_reason_label()}</label>
			<textarea id="{id}-reason" name="reason" minlength="3" maxlength="500" rows="2" required
			></textarea>
			<button type="submit">{m.admin_unban_submit()}</button>
		</form>
	{:else}
		<form method="POST" action="?/ban" use:enhance>
			<input type="hidden" name="userId" value={userId} />
			<label for="{id}-reason">{m.admin_reason_label()}</label>
			<textarea id="{id}-reason" name="reason" minlength="3" maxlength="500" rows="2" required
			></textarea>
			<label for="{id}-duration">{m.admin_ban_duration_label()}</label>
			<select id="{id}-duration" name="duration" required>
				{#each durations as duration (duration.value)}
					<option value={duration.value} selected={duration.value === '7'}>{duration.text}</option>
				{/each}
			</select>
			<button type="submit" class="danger">{m.admin_ban_submit()}</button>
		</form>
	{/if}
</details>

<style>
	details {
		margin-bottom: var(--space-2);
	}
	summary {
		cursor: pointer;
		color: var(--nav-link);
	}
	form {
		display: grid;
		gap: var(--space-1);
		margin-top: var(--space-2);
		min-width: 24ch;
	}
	textarea,
	select {
		padding: var(--space-1) var(--space-2);
		border: 1px solid var(--rule);
		border-radius: var(--rad-sm);
		background: var(--ink);
		color: var(--text);
		font-family: var(--mono);
	}
	button {
		justify-self: start;
		padding: var(--space-1) var(--space-3);
		border: 1px solid var(--accent);
		border-radius: var(--rad-sm);
		background: transparent;
		color: var(--accent-hi);
		font-family: var(--mono);
		cursor: pointer;
	}
	button.danger {
		border-color: var(--danger);
		color: var(--danger);
	}
	summary:focus-visible,
	textarea:focus-visible,
	select:focus-visible,
	button:focus-visible {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: var(--focus-offset);
	}
</style>
