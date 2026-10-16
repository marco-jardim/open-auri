<script lang="ts">
	// Audit rows as a plain table. Every value is rendered as text (Svelte escapes it), including
	// the free-text ban reasons inside `detail`.
	import { m } from '#lib/paraglide/messages.js';
	import { detailText, formatWhen, type AuditTableRow } from './format.ts';

	let { rows, locale }: { rows: AuditTableRow[]; locale: string } = $props();

	function actorLabel(kind: AuditTableRow['actorKind']): string {
		if (kind === 'admin') return m.admin_actor_admin();
		if (kind === 'operator') return m.admin_actor_operator();
		return m.admin_actor_system();
	}
</script>

{#if rows.length === 0}
	<p>{m.admin_audit_empty()}</p>
{:else}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex (Named scroll regions must be focusable for keyboard scrolling.) -->
	<div class="scroll" role="region" aria-label={m.admin_audit_heading()} tabindex="0">
		<table>
			<thead>
				<tr>
					<th scope="col">{m.admin_audit_col_when()}</th>
					<th scope="col">{m.admin_audit_col_actor()}</th>
					<th scope="col">{m.admin_audit_col_action()}</th>
					<th scope="col">{m.admin_audit_col_target()}</th>
					<th scope="col">{m.admin_audit_col_detail()}</th>
				</tr>
			</thead>
			<tbody>
				{#each rows as row (row.id)}
					<tr>
						<td
							><time datetime={new Date(row.createdAt).toISOString()}
								>{formatWhen(row.createdAt, locale)}</time
							></td
						>
						<td>{actorLabel(row.actorKind)}{row.actorId ? ` ${row.actorId}` : ''}</td>
						<td><code>{row.action}</code></td>
						<td>
							{#if row.targetId}
								<a href="/admin/auditoria?target={encodeURIComponent(row.targetId)}"
									>{row.targetKind ?? ''} {row.targetId}</a
								>
							{/if}
						</td>
						<td class="detail">{detailText(row.detail)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

<style>
	.scroll {
		overflow-x: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-family: var(--mono);
		font-size: var(--fs-ui);
	}
	th,
	td {
		padding: var(--space-1) var(--space-2);
		border-bottom: 1px solid var(--rule);
		text-align: start;
		vertical-align: top;
	}
	th {
		color: var(--muted);
		font-weight: 400;
		text-transform: uppercase;
		letter-spacing: var(--tracking-caps);
		font-size: var(--label-min);
	}
	.detail {
		max-width: 48ch;
		overflow-wrap: anywhere;
	}
	a {
		color: var(--nav-link);
	}
	a:focus-visible {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: var(--focus-offset);
	}
</style>
