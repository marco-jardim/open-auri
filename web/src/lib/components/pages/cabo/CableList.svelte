<!--
	U7 list of connected cables (FUX.P6, mock U7): one row per cable the service knows, with its
	state. Read-only: selecting, reviewing and confirming a queue happen only in the shared
	checklist (MultiCableQueue), never here.
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import type { CableState } from '#lib/cable/types.ts';
	import { queueStatus } from '#lib/components/cable/i18n.ts';
	import { Lamp } from '#lib/components/primitives/index.ts';
	import { cableLetter } from './model.ts';

	let { cable }: { cable: CableState | null } = $props();

	const rows = $derived(
		(cable?.devices ?? []).map((device, index) => {
			const label = cable?.deviceLabels[index] ?? '';
			const item = cable?.queue?.items.find((entry) => entry.deviceLabel === label) ?? null;
			const target = cable?.device === device;
			const writing = cable?.writing === true && target && item === null;
			const status =
				item !== null
					? queueStatus[item.status]()
					: writing
						? m.cabo_fux_cable_writing()
						: m.cabo_fux_cable_ready();
			return {
				letter: cableLetter(index),
				label,
				target,
				status,
				queueStatus: item?.status ?? null,
				lit: item?.status === 'writing' || writing
			};
		})
	);
</script>

{#if rows.length === 0}
	<p class="empty">{m.cabo_fux_cables_empty()}</p>
{:else}
	<ul class="devs" aria-label={m.cabo_fux_cables_label()}>
		{#each rows as row (row.letter)}
			<li class="dev" data-cable={row.letter} data-queue={row.queueStatus ?? undefined}>
				<Lamp on={row.lit || row.target} tone={row.lit ? 'ok' : 'accent'} />
				<span class="dev-name">{m.cabo_fux_cable_name({ letter: row.letter })}</span>
				<span class="dev-meta">{row.label} · 3302:8902</span>
				<span class="dev-status"
					>{row.status}{#if row.target}<span class="target">
							· {m.cabo_fux_cable_target()}</span
						>{/if}</span
				>
			</li>
		{/each}
	</ul>
{/if}
<p class="note">{m.cabo_fux_cables_note()}</p>

<style>
	.devs {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 7px;
	}
	.dev {
		display: grid;
		grid-template-columns: 18px 110px minmax(0, 1fr) auto;
		gap: 12px;
		align-items: center;
		padding: 8px 12px;
		border-radius: 3px;
		background: #0d0f10;
		box-shadow:
			inset 0 1px 3px #000,
			0 1px 0 #ffffff12;
	}
	.dev-name {
		font: 600 var(--fs-ui, 14px) var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: #e9ece8;
	}
	.dev-meta {
		min-width: 0;
		overflow-wrap: anywhere;
		font: 400 var(--fs-caption, 12px) var(--face-data, 'JetBrains Mono', monospace);
		color: #a7aea9;
	}
	.dev-status {
		font: 400 var(--fs-caption, 12px) var(--face-data, 'JetBrains Mono', monospace);
		color: #a6f6ed;
		text-align: right;
	}
	.target {
		color: #d7dbd6;
	}
	.empty,
	.note {
		margin: 12px 0 0;
		font-size: var(--fs-small, 13px);
		line-height: 1.55;
		color: #b6bdb7;
	}
	@media (max-width: 820px) {
		.dev {
			grid-template-columns: 18px minmax(0, 1fr);
		}
		.dev-meta,
		.dev-status {
			grid-column: 2;
			text-align: left;
		}
	}
</style>
