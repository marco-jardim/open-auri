<!--
	An EXAMPLE channel strip of the empty console (spec §4.4, T12): an official preset drawn like a
	published channel so the visitor sees what the desk will hold. It is not interactive and not a
	publication: no SOLO, no SEL, no link, labelled "exemplo, não publicado" on the tape. The meter
	bridge stays dark (no audio, no decorative meter); the knobs are the preset's own response.
-->
<script lang="ts">
	import { formatNumber } from '#lib/components/cable/i18n.ts';
	import { m } from '#lib/paraglide/messages.js';
	import CurveAvatar from './CurveAvatar.svelte';
	import { encodeCurve, knobAngle, knobSummary, type DecodedCurve } from './model.ts';

	let {
		name,
		curve,
		number
	}: {
		name: string;
		curve: DecodedCurve;
		number: number;
	} = $props();

	const chno = $derived(String(number).padStart(2, '0'));
	const knobs = $derived(knobSummary(curve));
	const s1 = $derived(encodeCurve(curve) ?? name);
</script>

<li
	class="ex-strip"
	data-testid="example-strip"
	aria-label={m.comunidade_v2_example_strip({ number: chno, name })}
>
	<div class="bridge-seg" aria-hidden="true">
		<span class="meter-off"></span>
		<span class="chno">{chno}</span>
	</div>
	<div class="face">
		<span class="ex-tag">{m.empty_example()}</span>
		<CurveAvatar {curve} {s1} label={m.comunidade_avatar_label({ name })} />
		<div class="knobs">
			<div class="ro-knob">
				<span class="k-lbl">{m.comunidade_knob_bass()}</span>
				<span class="knob" style:--angle="{knobAngle(knobs.bass)}deg" aria-hidden="true"
					><i class="cp"></i></span
				>
				<span class="k-val">{formatNumber(knobs.bass, 1, true)}</span>
			</div>
			<div class="ro-knob">
				<span class="k-lbl">{m.comunidade_knob_treble()}</span>
				<span class="knob treble" style:--angle="{knobAngle(knobs.treble)}deg" aria-hidden="true"
					><i class="cp"></i></span
				>
				<span class="k-val">{formatNumber(knobs.treble, 1, true)}</span>
			</div>
		</div>
		<div class="scribble">
			<span class="m1">{m.comunidade_v2_example_author()}</span>
			<span class="m2">{name}</span>
			<span class="unpublished">{m.empty_example_unpublished()}</span>
		</div>
	</div>
</li>

<style>
	.ex-strip {
		width: 104px;
		flex: 0 0 104px;
		display: flex;
		flex-direction: column;
		border-right: 1px solid #0b0c0d;
		box-shadow: inset 1px 0 0 #ffffff12;
		list-style: none;
	}
	.bridge-seg {
		height: 132px;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: flex-end;
		padding: var(--space-2) 0;
		background: linear-gradient(#111213, #1b1c1e);
		border-bottom: 7px solid #0d0e0f;
	}
	.meter-off {
		display: block;
		width: 16px;
		height: 86px;
		border-radius: var(--rad-xs);
		background: #070808;
		box-shadow: 0 0 0 1px #000;
	}
	.chno {
		margin-top: 6px;
		color: var(--muted-hi);
		font: 500 var(--fs-caption) var(--face-data);
		letter-spacing: var(--tracking-data);
	}
	.face {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
		padding: 14px var(--space-1) var(--space-3);
		background:
			repeating-linear-gradient(90deg, #ffffff04 0 1px, transparent 1px 3px),
			linear-gradient(180deg, #303337, #282a2d 50%, #232528);
	}
	.ex-tag {
		padding: 2px 6px;
		border: 1px solid var(--rule-control);
		border-radius: var(--rad-xs);
		color: var(--text-2);
		font: 500 var(--label-min) / var(--lh-caps) var(--face-data);
		letter-spacing: var(--tracking-caps);
	}
	.knobs {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 2px;
		width: 100%;
	}
	.ro-knob {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-1);
	}
	.k-lbl {
		color: var(--text-2);
		font: 500 var(--label-min) var(--face-data);
	}
	.k-val {
		color: #ffd79a;
		font: 400 var(--label-min) var(--face-data);
		font-variant-numeric: tabular-nums slashed-zero;
	}
	.knob {
		position: relative;
		width: 26px;
		height: 26px;
		border-radius: 50%;
		background:
			radial-gradient(circle at 32% 28%, #ffffff33, transparent 46%),
			repeating-conic-gradient(#141516 0 5deg, #3c3e41 5deg 10deg);
		box-shadow:
			2px 4px 5px #000c,
			inset 0 0 0 1px #000;
	}
	.knob .cp {
		position: absolute;
		inset: 21%;
		border-radius: 50%;
		background: radial-gradient(circle at 35% 30%, #ffb3b0, #d9483f 55%, #6d1d18);
		transform: rotate(var(--angle));
	}
	.knob.treble .cp {
		background: radial-gradient(circle at 35% 30%, #c8e2ff, #3f7fd9 55%, #173d6d);
	}
	.knob .cp::after {
		content: '';
		position: absolute;
		left: calc(50% - 1px);
		top: -30%;
		width: 2px;
		height: 62%;
		border-radius: 1px;
		background: #f6f3ec;
	}
	.scribble {
		width: 100%;
		min-height: 64px;
		margin-top: auto;
		padding: 6px var(--space-1) 5px;
		background: var(--tape);
		color: var(--marker-ink);
		box-shadow: 0 2px 3px #000a;
		transform: rotate(-0.6deg);
		font-family: var(--marker);
		line-height: 1.08;
		text-align: center;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 3px;
	}
	.m1 {
		font-size: var(--label-min);
		color: #23255f;
	}
	.m2 {
		font-size: var(--fs-ui);
		color: #141414;
		overflow-wrap: anywhere;
	}
	.unpublished {
		padding: 1px var(--space-1);
		border: 1px dashed #5a4b2f;
		color: #4a3a1c;
		font: 500 var(--label-min) / 1.2 var(--face-body);
	}
</style>
