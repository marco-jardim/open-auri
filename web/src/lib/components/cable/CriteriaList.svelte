<!--
	Gate criteria (a)–(g) plus (k), each with its lamp, value and limit (FUX.P6, mock U3).
	The lamp state and the reasons come from the checklist verdict; the values only describe
	the same verdict (see criteria.ts). A failing criterion offers its own explainer.
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import type { Lamp as GateLamp, LampId } from '#lib/cable/types.ts';
	import { Lamp } from '#lib/components/primitives/index.ts';
	import Explainer from '#lib/components/comprehension/Explainer.svelte';
	import type { ExplainerId } from '#lib/comprehension/explainers.ts';
	import type { CriterionValue } from './criteria.ts';
	import { describeReason, lampLabel, lampState } from './i18n.ts';

	interface Props {
		lamps: readonly GateLamp[];
		values: Record<LampId, CriterionValue>;
		label: string;
	}

	let { lamps, values, label }: Props = $props();

	const EXPLAINERS: Partial<Record<LampId, ExplainerId>> = {
		a: 'gate-a',
		b: 'gate-b',
		c: 'gate-c',
		d: 'gate-d',
		e: 'gate-e',
		f: 'gate-f',
		g: 'gate-g'
	};
</script>

<ol class="criteria" aria-label={label}>
	{#each lamps as lamp (lamp.id)}
		{@const value = values[lamp.id]}
		{@const explainer = EXPLAINERS[lamp.id]}
		<li class="criterion" data-lamp={lamp.id} data-state={lamp.state}>
			<span class="row">
				<Lamp
					on={lamp.state !== 'unknown'}
					tone={lamp.state === 'fail' ? 'danger' : 'accent'}
					class="criterion__lamp"
				/>
				<span class="key">({lamp.id})</span>
				<span class="label">{lampLabel[lamp.labelKey]()}</span>
				<span class="state">{lampState[lamp.state]()}</span>
			</span>
			{#if value.value !== null}
				<span class="value"
					>{value.value}{#if value.limit !== null}<span class="limit"
							>{m.cable_fux_limit({ limit: value.limit })}</span
						>{/if}</span
				>
			{/if}
			{#if lamp.reasons.length > 0}
				<ul class="reasons">
					{#each lamp.reasons as reason, index (index)}
						<li>{describeReason(reason)}</li>
					{/each}
				</ul>
				{#if explainer !== undefined}<span class="explain"><Explainer term={explainer} /></span
					>{/if}
			{/if}
		</li>
	{/each}
</ol>

<style>
	.criteria {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 6px;
	}
	.criterion {
		display: grid;
		gap: 2px;
		padding: 7px 10px;
		border-radius: 3px;
		background: linear-gradient(180deg, #0000000f, #ffffff26);
		box-shadow:
			inset 0 1px 2px #0003,
			0 1px 0 #ffffff80;
	}
	.criterion[data-state='fail'] {
		box-shadow:
			inset 3px 0 0 #a3262c,
			inset 0 1px 2px #0003,
			0 1px 0 #ffffff80;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	.row :global(.criterion__lamp) {
		flex: none;
	}
	.key {
		font: 500 var(--fs-caption, 12px) var(--face-data, 'JetBrains Mono', monospace);
	}
	.label {
		min-width: 0;
		font: 600 var(--fs-small, 13px) / 1.25 var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.05em;
		text-transform: uppercase;
		overflow-wrap: anywhere;
	}
	.state {
		margin-left: auto;
		font: 400 var(--fs-caption, 12px) var(--face-data, 'JetBrains Mono', monospace);
		white-space: nowrap;
	}
	.value {
		display: flex;
		flex-wrap: wrap;
		gap: 2px 12px;
		padding-left: 26px;
		font: 400 var(--fs-caption, 12px) / 1.4 var(--face-data, 'JetBrains Mono', monospace);
		font-variant-numeric: tabular-nums slashed-zero;
	}
	.limit {
		color: inherit;
	}
	.reasons {
		margin: 4px 0 0;
		padding-left: 42px;
		color: #761115;
		font: 600 var(--fs-caption, 12px) / 1.45 var(--face-body, 'Geist', sans-serif);
	}
	.explain {
		padding-left: 26px;
	}
</style>
