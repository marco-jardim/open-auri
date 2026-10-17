<!--
	Loudness block of the checklist (FUX.P6, mock U3). The literal warning is ALWAYS visible
	(plan §3.4, spec §4.3); the lamp next to it lights only when the policy raises it (first
	write of the session, an interruption, or a jump of +3 dB or more). The jump ("salto") is
	the reason for the warning, so it is always shown as a readout, "n/d" when unknown.
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import type { ChecklistResult } from '#lib/cable/types.ts';
	import { Lamp } from '#lib/components/primitives/index.ts';
	import { formatNumber } from './i18n.ts';

	interface Props {
		/** The checklist's loudness result; null before the cable engine exists. */
		loudness: ChecklistResult['loudness'] | null;
		newLevelDb: number | null;
		/** Heading level inside the host (dialog h3, rack unit h3). */
		heading?: boolean;
	}

	let { loudness, newLevelDb, heading = true }: Props = $props();
	const id = $props.id();

	const warn = $derived(loudness?.warn === true);
	const deltaDb = $derived(loudness?.deltaDb ?? null);
	const lastDb = $derived(newLevelDb !== null && deltaDb !== null ? newLevelDb - deltaDb : null);
	const unknown = () => m.cable_fux_level_unknown();
	const dB = (value: number, signed = false) => `${formatNumber(value, 1, signed)} dB`;
</script>

<section
	class="loud"
	data-loudness={warn ? 'warn' : 'calm'}
	aria-labelledby={heading ? `${id}-title` : undefined}
	aria-label={heading ? undefined : m.cable_loudness_heading()}
>
	{#if heading}<h3 id={`${id}-title`} class="title">{m.cable_loudness_heading()}</h3>{/if}
	<dl class="readouts">
		<div>
			<dt>{m.cable_fux_level_now()}</dt>
			<dd class="lcd">{newLevelDb === null ? unknown() : dB(newLevelDb, true)}</dd>
		</div>
		<div>
			<dt>{m.cable_fux_level_last()}</dt>
			<dd class="lcd">{lastDb === null ? unknown() : dB(lastDb, true)}</dd>
		</div>
		<div class="jump">
			<dt>{m.cable_fux_level_jump()}</dt>
			<dd
				class="lcd"
				data-jump={deltaDb === null
					? 'unknown'
					: loudness?.reasons.includes('jump')
						? 'over'
						: 'under'}
			>
				{deltaDb === null ? unknown() : dB(deltaDb, true)}
			</dd>
		</div>
	</dl>
	<div class="warning-row">
		<Lamp on={warn} tone="warn" label={m.cable_fux_warning_lamp()} class="loud__lamp" />
		<p class="warning">{m.cable_loudness_warning()}</p>
	</div>
	{#if loudness !== null && loudness.reasons.includes('jump') && deltaDb !== null}
		<p class="detail">{m.cable_loudness_jump({ delta: formatNumber(deltaDb, 1, true) })}</p>
	{/if}
	{#if loudness !== null && loudness.reasons.includes('unknown-state')}
		<p class="detail">{m.cable_loudness_unknown()}</p>
	{/if}
	<p class="why">{m.cable_fux_jump_why()}</p>
</section>

<style>
	.loud {
		display: grid;
		gap: 8px;
		padding: 10px 12px;
		border-radius: 4px;
		background: #0000000d;
		box-shadow:
			inset 0 1px 3px #0003,
			0 1px 0 #ffffff80;
	}
	.loud[data-loudness='warn'] {
		box-shadow:
			inset 3px 0 0 #b26b00,
			inset 0 1px 3px #0003,
			0 1px 0 #ffffff80;
	}
	.title {
		margin: 0;
		font: 600 var(--fs-small, 13px) / 1.2 var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}
	.readouts {
		display: grid;
		gap: 6px;
		margin: 0;
	}
	.readouts div {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}
	dt {
		font: 600 var(--fs-caption, 12px) / 1.25 var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}
	dd {
		margin: 0;
	}
	.lcd {
		flex: none;
		padding: 3px 8px;
		border-radius: 2px;
		background: #0b1312;
		color: #8fe9df;
		font: 500 var(--fs-caption, 12px) var(--face-data, 'JetBrains Mono', monospace);
		font-variant-numeric: tabular-nums slashed-zero;
		box-shadow:
			inset 0 1px 3px #000,
			0 1px 0 #ffffff60;
	}
	.jump .lcd[data-jump='over'] {
		color: #ffd08a;
	}
	.warning-row {
		display: flex;
		align-items: flex-start;
		gap: 9px;
	}
	.warning-row :global(.loud__lamp) {
		flex: none;
		margin-top: 2px;
	}
	.warning {
		margin: 0;
		font: 600 var(--fs-small, 13px) / 1.45 var(--face-body, 'Geist', sans-serif);
		color: #123b38;
	}
	.detail,
	.why {
		margin: 0;
		font: 400 var(--fs-caption, 12px) / 1.45 var(--face-body, 'Geist', sans-serif);
		color: #2f3335;
	}
	.why {
		color: #3d4244;
	}
</style>
