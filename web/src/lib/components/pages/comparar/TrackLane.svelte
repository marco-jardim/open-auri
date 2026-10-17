<script lang="ts">
	import { getPreset, OFFICIAL_PRESETS } from 'open-auri/catalog';
	import { levelDb } from 'open-auri/dsp';
	import { isExperimentalKind } from 'open-auri/safety';
	import MiniCurve from '#lib/charts/MiniCurve.svelte';
	import VuMeter from '#lib/components/meters/VuMeter.svelte';
	import type { MeterSource, MeterUpdate } from '#lib/audio/meters.ts';
	import { numberLabel } from '#lib/charts/scales.ts';
	import type { Track } from './comparison.ts';
	import type { Copy } from './copy.ts';
	interface Props {
		track: Track;
		t: Copy;
		locale: 'pt-BR' | 'en-US';
		selected: boolean;
		/** This page's own audition is running; only then can a meter be live. */
		playing: boolean;
		meter?: MeterSource | null;
		library: readonly { id: string; name: string }[];
		/** A or B when this lane is in the level-matched pair, otherwise null. */
		pairTag?: 'A' | 'B' | null;
		/** Attenuation applied to this lane by level matching, in dB (never positive). */
		trimDb?: number | null;
		matched?: boolean;
		/** Carries the tour anchor for the ARM step (one lane only). */
		tourArm?: boolean;
		onSource: (source: string) => void;
		onToggle: (key: 'armed' | 'mute' | 'solo') => void;
		onSelect: () => void;
	}
	let {
		track,
		t,
		locale,
		selected,
		playing,
		meter = null,
		library,
		pairTag = null,
		trimDb = null,
		matched = true,
		tourArm = false,
		onSource,
		onToggle,
		onSelect
	}: Props = $props();
	/** Trim fader travel: 12 dB, the widest attenuation the level match can need in practice. */
	const TRIM_TRAVEL_DB = 12;
	let update = $state<MeterUpdate>({ mode: 'data', frame: null });
	$effect(() => {
		update = { mode: 'data', frame: null };
		return meter?.subscribe((next) => {
			update = next;
		});
	});
	const mode = $derived(playing && track.armed ? update.mode : 'data');
	const liveReading = $derived(update.frame ? Math.max(update.frame.vuL, update.frame.vuR) : null);
	const preset = $derived(
		track.curve.source.startsWith('preset:') ? getPreset(track.curve.source.slice(7)) : undefined
	);
	const description = $derived(preset && 'description' in preset ? preset.description : t.snapshot);
	const experimental = $derived(track.curve.bands.some((band) => isExperimentalKind(band.kind)));
	const predicted = $derived(levelDb(track.curve.bands, track.curve.preampDb));
	// Level matching only ever lowers: a positive trim would be a bug upstream, never shown as a boost.
	const trim = $derived(trimDb === null ? null : Math.min(0, trimDb));
	const trimFraction = $derived(trim === null ? 0 : Math.min(1, -trim / TRIM_TRAVEL_DB));
	const trimText = $derived(
		!track.armed || pairTag === null
			? t.levelTrimOff
			: !matched
				? t.levelTrimUnmatched
				: `${numberLabel(trim ?? 0, locale, 1)} dB`
	);
</script>

<div
	class="lane"
	class:is-selected={selected}
	class:is-off={!track.armed}
	style:--lane={track.color}
>
	<span class="tape-edge" aria-hidden="true"></span>
	<button class="lane-head" aria-pressed={selected} onclick={onSelect} disabled={!track.armed}>
		{t.track}
		{track.id}<span class="lane-led" aria-hidden="true"></span>
	</button>
	<div class="tape-label">
		<label class="sr-only" for="comparar-source-{track.id}">{t.curveSource} {track.id}</label>
		<select
			id="comparar-source-{track.id}"
			value={track.curve.source}
			onchange={(event) => {
				const value = event.currentTarget.value;
				event.currentTarget.value = track.curve.source;
				onSource(value);
			}}
		>
			{#if !track.curve.source.startsWith('preset:')}<option value={track.curve.source}
					>{track.curve.name}</option
				>{/if}
			<option value="current">{t.current}</option>
			<option value="preset:neutro">{t.neutral}</option>
			<optgroup label={t.presets}
				>{#each OFFICIAL_PRESETS as choice (choice.id)}<option value="preset:{choice.id}"
						>{choice.label}</option
					>{/each}</optgroup
			>
			<optgroup label={t.library}
				>{#each library as choice (choice.id)}<option value="library:{choice.id}"
						>{choice.name}</option
					>{/each}</optgroup
			>
		</select>
		<MiniCurve
			curve={track.curve}
			label={track.curve.name}
			description={t.responseNote}
			color="#584321"
		/>
		<p>{description}</p>
		{#if preset && 'description' in preset}<small
				>{locale === 'pt-BR' ? t.descriptionCredit : t.descriptionOriginal}</small
			>{/if}
		{#if experimental}<small class="experimental">{t.experimental}</small>{/if}
	</div>
	<div class="vu-face" aria-hidden={mode === 'data' ? 'true' : undefined}>
		<VuMeter {mode} live={liveReading} label="VU · {track.id}" />
	</div>
	<div class="lane-read">
		<span>{mode === 'live' ? t.live : t.data}</span>
		<output>
			{#if mode === 'live' && liveReading !== null}
				{numberLabel(liveReading, locale, 1)} VU
			{:else}
				{numberLabel(predicted, locale, 1)} dB
			{/if}
		</output>
	</div>
	<div class="lane-level">
		<dl>
			<div class="level-row">
				<dt>{t.levelPredicted}</dt>
				<dd class="predicted">{numberLabel(predicted, locale, 1)} dB</dd>
			</div>
			<div class="level-row">
				<dt>{t.levelTrim}{pairTag ? ` · ${pairTag}` : ''}</dt>
				<dd class="trim" data-trim={trim ?? ''}>{trimText}</dd>
			</div>
		</dl>
		<div
			class="trim-fader"
			class:is-idle={trim === null || !matched}
			style:--trim={trimFraction}
			aria-hidden="true"
		>
			<span class="trim-knob"></span>
		</div>
	</div>
	<div class="levers" data-tour={tourArm ? 'comparar-arm' : undefined}>
		{#each [{ key: 'armed', label: 'ARM' }, { key: 'solo', label: 'SOLO' }, { key: 'mute', label: 'MUTE' }] as lever (lever.key)}
			<button
				class="lever"
				role="switch"
				aria-checked={track[lever.key as 'armed' | 'solo' | 'mute']}
				aria-label="{lever.label} · {t.track} {track.id}"
				onclick={() => onToggle(lever.key as 'armed' | 'solo' | 'mute')}
			>
				<span class="lv-led" aria-hidden="true"></span><span class="lv-base" aria-hidden="true"
					><span class="lv-bat"></span></span
				><span>{lever.label}</span>
			</button>
		{/each}
	</div>
</div>

<style>
	/* A lane is a strip of tape: oxide coat, a coloured leader edge and a typed paper label. */
	.lane {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: var(--space-2, 8px);
		min-width: 0;
		padding: 12px 8px 8px;
		border-radius: 7px;
		background:
			repeating-linear-gradient(90deg, #ffffff06 0 1px, transparent 1px 5px),
			linear-gradient(#3a2a1c, #23180f 60%, #1a120b);
		box-shadow:
			inset 0 1px #ffffff19,
			inset 0 0 0 1px #0007,
			0 3px 8px #0008;
	}
	.tape-edge {
		position: absolute;
		inset: 0 0 auto;
		height: 5px;
		border-radius: 7px 7px 0 0;
		background: linear-gradient(90deg, var(--lane), color-mix(in srgb, var(--lane) 55%, #000));
	}
	.is-selected {
		box-shadow:
			inset 0 0 0 2px #f2b33d,
			0 0 22px #f2b33d33;
	}
	.is-off {
		background: #282b29;
	}
	button,
	select {
		font: inherit;
		cursor: pointer;
	}
	:focus-visible {
		outline: 2px solid #f2b33d;
		outline-offset: 3px;
	}
	.lane-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 5px;
		width: 100%;
		padding: 5px 7px;
		border: 1px solid #060606;
		border-radius: 3px;
		color: #e9e4d6;
		background: linear-gradient(#2c2e2d, #191a1a);
		font-family: var(--plate);
		font-size: var(--fs-small, 13px);
		text-transform: uppercase;
		letter-spacing: 0.13em;
	}
	.lane-head:disabled {
		cursor: default;
		color: #bdb9b0;
	}
	.lane-led {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--lane);
	}
	.tape-label {
		flex: 1;
		padding: 6px 7px;
		border-top: 4px solid var(--lane);
		border-radius: 2px;
		color: #2b2620;
		background: repeating-linear-gradient(transparent 0 13px, #46648c19 13px 14px), #efe6cf;
		box-shadow: 2px 3px 5px #0007;
		transform: rotate(-0.5deg);
	}
	select {
		width: 100%;
		padding: 0;
		border: 0;
		background: transparent;
		color: #221d17;
		font-family: var(--tape);
		font-size: var(--fs-ui, 14px);
	}
	option,
	optgroup {
		color: #111;
		background: #f3ecdd;
		font-family: var(--face-body);
		font-size: var(--fs-small, 13px);
	}
	p {
		margin: 3px 0;
		font-size: var(--fs-caption, 12px);
		line-height: 1.3;
	}
	small {
		display: block;
		color: #584e40;
		font-size: var(--label-min, 11px);
	}
	.experimental {
		margin-top: 4px;
		padding: 3px;
		color: #251a06;
		background: #f2b33d;
	}
	.vu-face {
		padding: 5px;
		border: 5px solid #1b1916;
		border-radius: 7px;
		color: #2f2418;
		background: radial-gradient(at 50% 20%, #fff4d6, #d8c08a);
		--oa-meter-ink: #2f2418;
	}
	.lane-read {
		display: flex;
		justify-content: space-between;
		gap: 3px;
		color: #e6ddc8;
		font-family: var(--face-data);
		font-size: var(--label-min, 11px);
		font-variant-numeric: tabular-nums slashed-zero;
	}
	output {
		color: #ffe0a0;
	}
	.lane-level {
		display: grid;
		gap: 3px;
		margin: 0;
		padding: 6px;
		border-radius: 4px;
		background: #0c0a08;
		box-shadow: inset 0 1px 3px #000c;
	}
	dl {
		display: grid;
		gap: 3px;
		margin: 0;
	}
	.level-row {
		display: flex;
		justify-content: space-between;
		gap: 6px;
		align-items: baseline;
	}
	dt {
		color: #cfc6b2;
		font-family: var(--plate);
		font-size: var(--label-min, 11px);
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}
	dd {
		margin: 0;
		color: #ffe0a0;
		font-family: var(--face-data);
		font-size: var(--label-min, 11px);
		font-variant-numeric: tabular-nums slashed-zero;
		text-align: right;
	}
	.trim {
		color: #f2b33d;
	}
	.trim-fader {
		position: relative;
		height: 8px;
		margin-top: 2px;
		border-radius: 4px;
		background: linear-gradient(90deg, #f2b33d55, #2a2622 70%);
		box-shadow: inset 0 1px 2px #000;
	}
	.trim-fader.is-idle {
		background: #2a2622;
	}
	/* 0 dB sits on the right; the knob slides left by the calculated trim, once per change. */
	.trim-knob {
		position: absolute;
		top: -3px;
		left: calc((1 - var(--trim)) * (100% - 10px));
		width: 10px;
		height: 14px;
		border-radius: 2px;
		background: linear-gradient(#f5f5f2, #8c8f8c);
		box-shadow: 0 1px 2px #000a;
		transition: left var(--dur-scene, 0.72s) var(--ease-mech, ease-out);
	}
	.levers {
		display: flex;
		justify-content: space-between;
		gap: 2px;
	}
	.lever {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 5px;
		min-width: 34px;
		padding: 3px 0;
		border: 0;
		color: #e9e4d6;
		background: none;
		font-family: var(--plate);
		font-size: var(--label-min, 11px);
		letter-spacing: 0.1em;
	}
	.lv-led {
		width: 13px;
		height: 13px;
		border-radius: 50%;
		background: radial-gradient(circle at 35% 30%, #6a6560, #2a2724);
		box-shadow:
			inset 0 -2px 3px #0009,
			0 0 0 2px #1a1918,
			0 0 0 3px #4b4d4c;
	}
	[aria-checked='true'] .lv-led {
		background: radial-gradient(circle at 35% 30%, #fff2c8, #f2b33d 45%, #8a5a10);
		box-shadow:
			0 0 10px #f2b33dbb,
			0 0 0 2px #1a1918,
			0 0 0 3px #4b4d4c;
	}
	.lv-base {
		position: relative;
		width: 26px;
		height: 26px;
		border-radius: 50%;
		background: radial-gradient(at 35% 30%, #f5f5f2, #a3a6a3 42%, #555856 72%, #2f3130);
		box-shadow: 2px 3px 4px #0009;
	}
	.lv-bat {
		position: absolute;
		left: 9px;
		top: 50%;
		width: 9px;
		height: 19px;
		border-radius: 5px;
		background: linear-gradient(90deg, #000, #45413d 40%, #141312);
	}
	[aria-checked='true'] .lv-bat {
		transform: translateY(-100%);
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	@media (prefers-reduced-motion: reduce) {
		.trim-knob {
			transition: none;
		}
	}
</style>
