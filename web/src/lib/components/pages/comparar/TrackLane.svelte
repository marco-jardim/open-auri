<script lang="ts">
	import { getPreset, OFFICIAL_PRESETS } from 'open-auri/catalog';
	import { levelDb } from 'open-auri/dsp';
	import { isExperimentalKind } from 'open-auri/safety';
	import { MiniCurve } from '#lib/charts/index.ts';
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
		playing: boolean;
		meter?: MeterSource | null;
		library: readonly { id: string; name: string }[];
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
		onSource,
		onToggle,
		onSelect
	}: Props = $props();
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
</script>

<div
	class="lane"
	class:is-selected={selected}
	class:is-off={!track.armed}
	style:--lane={track.color}
>
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
				{numberLabel(levelDb(track.curve.bands, track.curve.preampDb), locale, 1)} dB
			{/if}
		</output>
	</div>
	<div class="levers">
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
	.lane {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
		padding: 8px;
		border-radius: 7px;
		background: linear-gradient(#0002, #0005);
		box-shadow:
			inset 0 1px #ffffff19,
			inset 0 0 0 1px #0007;
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
		font:
			13px 'Oswald',
			sans-serif;
		text-transform: uppercase;
		letter-spacing: 0.13em;
	}
	.lane-head:disabled {
		cursor: default;
		color: #bdb9b0;
	}
	.lane-led {
		width: 9px;
		height: 9px;
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
		font:
			15px 'Special Elite',
			monospace;
	}
	option,
	optgroup {
		color: #111;
		background: #f3ecdd;
		font: 13px sans-serif;
	}
	p {
		margin: 3px 0;
		font-size: 10.5px;
		line-height: 1.3;
	}
	small {
		display: block;
		color: #584e40;
		font-size: 9.5px;
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
		font:
			9px 'JetBrains Mono',
			monospace;
	}
	output {
		color: #ffe0a0;
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
		min-width: 30px;
		padding: 3px 0;
		border: 0;
		color: #e9e4d6;
		background: none;
		font:
			10px 'Oswald',
			sans-serif;
		letter-spacing: 0.1em;
	}
	.lv-led {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: #332e24;
	}
	[aria-checked='true'] .lv-led {
		background: #f2b33d;
		box-shadow: 0 0 7px #f2b33d;
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
</style>
