<!--
	Official presets from `open-auri/catalog`, as hardware cards (mock v2 .tab): lamp, bold name and a
	mini curve of the real response, grouped as preference and reference curves. The description line
	under the cards says "name · description", then credit, licence, preamp and CRC (catalog data,
	Kuba's descriptions; licence still to be confirmed). Loading a preset only changes the editor;
	nothing is written. The lamp lights on the preset the editor holds unedited (real state).
-->
<script lang="ts">
	import { presetsByGroup, type OFFICIAL_PRESETS } from 'open-auri/catalog';
	import { m } from '#lib/paraglide/messages.js';
	import Lamp from '#lib/components/primitives/Lamp.svelte';
	import { formatSignedDb, hex } from './format.ts';
	import { miniPath } from './mini.ts';

	type OfficialPreset = (typeof OFFICIAL_PRESETS)[number];

	interface Props {
		/** `preset:<id>` of the editor curve, when it is an unedited official preset. */
		activeId: string | null;
		locale: string;
		onload: (id: string) => void;
	}
	let { activeId, locale, onload }: Props = $props();

	const groups = [
		{ id: 'preferencia', title: () => m.curva_presets_pref() },
		{ id: 'referencia', title: () => m.curva_presets_ref() }
	] as const;
	const all = groups.flatMap((group) => presetsByGroup(group.id));
	// Thumbnails of the real responses, computed once (catalog data never changes).
	const minis = new Map(all.map((preset) => [preset.id, miniPath(preset.bands)]));
	let focused = $state<string | null>(null);
	const shown = $derived(all.find((preset) => preset.id === (focused ?? activeId)) ?? null);
	const uid = $props.id();
	const descId = `${uid}-desc`;

	function description(preset: OfficialPreset): string {
		const english = locale.startsWith('en') ? preset.descriptionEn : null;
		return english ?? preset.description;
	}
	function crcOf(preset: OfficialPreset): string {
		return `0x${hex(preset.crc, 4)}`;
	}
</script>

<section class="psec ps-pre" aria-labelledby="{uid}-legend" data-tour="curva-presets">
	{#each groups as group, position (group.id)}
		<p class="tabs-cap" class:later={position > 0} id="{uid}-{group.id}">{group.title()}</p>
		<div class="tabs" role="group" aria-labelledby="{uid}-{group.id}">
			{#each presetsByGroup(group.id) as preset (preset.id)}
				<button
					type="button"
					class="tab"
					aria-pressed={activeId === preset.id}
					aria-describedby={descId}
					onclick={() => onload(preset.id)}
					onfocus={() => (focused = preset.id)}
					onblur={() => (focused = null)}
					onpointerenter={() => (focused = preset.id)}
					onpointerleave={() => (focused = null)}
				>
					<Lamp on={activeId === preset.id} class="tab-lamp" />
					<span class="tab-name">{preset.label}</span>
					<svg class="tab-mini" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true">
						<line x1="0" y1="10" x2="100" y2="10" />
						<path d={minis.get(preset.id) ?? ''} vector-effect="non-scaling-stroke" />
					</svg>
				</button>
			{/each}
		</div>
	{/each}
	<p class="desc" id={descId} aria-live="polite">
		{#if shown}
			<span class="desc-line"><b>{shown.label}</b> · <q>{description(shown)}</q></span>
			<small
				>{m.curva_preset_kuba()} · {m.curva_preset_license()} · {m.curva_v2_preset_meta({
					preamp: formatSignedDb(shown.preampDb, locale),
					crc: crcOf(shown)
				})}</small
			>
		{/if}
	</p>
	<h2 class="legend-bar" id="{uid}-legend">{m.curva_presets_heading()}</h2>
</section>

<style>
	.tabs-cap {
		display: flex;
		gap: var(--space-2);
		align-items: center;
		margin: var(--space-1) 0 6px;
		color: var(--text-2);
		font: 600 var(--label-min) / var(--lh-caps) var(--face-engrave);
		letter-spacing: 0.2em;
		text-transform: uppercase;
	}
	.tabs-cap::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--rule);
	}
	.tabs-cap.later {
		margin-top: var(--space-3);
	}
	.tabs {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
		gap: 6px;
	}
	.tab {
		display: grid;
		grid-template-columns: 10px minmax(0, 1fr);
		grid-template-rows: auto auto;
		column-gap: 7px;
		align-items: center;
		min-height: 44px;
		padding: 6px 8px 5px;
		border: 1px solid #000;
		border-radius: var(--rad-sm);
		background: linear-gradient(180deg, #2c2b28 0%, #1d1c1a 48%, #141311 52%, #0f0e0d 100%);
		box-shadow:
			var(--bevel),
			0 3px 0 #050505,
			0 4px 6px rgb(0 0 0 / 0.6);
		color: var(--text);
		text-align: left;
		cursor: pointer;
		transition:
			transform var(--dur-instant) var(--ease-mech),
			box-shadow var(--dur-instant) var(--ease-out),
			border-color var(--dur-fast) var(--ease-out);
	}
	.tab:hover {
		border-color: var(--rule-control);
	}
	.tab[aria-pressed='true'] {
		transform: translateY(2px);
		background: linear-gradient(180deg, #151412, #1d1c19);
		box-shadow:
			var(--well),
			0 1px 0 #050505;
	}
	.tab:focus-visible {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: var(--focus-offset);
	}
	.tab :global(.tab-lamp) {
		grid-row: 1 / 3;
		width: 7px;
		height: 7px;
	}
	.tab-name {
		overflow: hidden;
		font: 600 var(--fs-small) / 1.05 var(--face-engrave);
		letter-spacing: 0.04em;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tab-mini {
		display: block;
		width: 100%;
		height: 20px;
	}
	.tab-mini line {
		stroke: var(--rule);
	}
	.tab-mini path {
		fill: none;
		stroke: var(--text-2);
		stroke-opacity: 0.55;
		stroke-width: 1.2;
	}
	.tab[aria-pressed='true'] .tab-mini path {
		stroke: var(--accent);
		stroke-opacity: 1;
		filter: drop-shadow(0 0 3px color-mix(in srgb, var(--accent) 60%, transparent));
	}
	.desc {
		display: grid;
		gap: var(--space-1);
		min-height: 3.2em;
		margin: var(--space-3) 0 0;
		color: var(--text);
		font: 400 var(--fs-caption) / var(--lh-small) var(--face-body);
	}
	.desc q {
		font-style: italic;
	}
	.desc small {
		color: var(--text-2);
		font: 400 var(--label-min) / var(--lh-small) var(--face-data);
	}
	@media (prefers-reduced-motion: reduce) {
		.tab {
			transition: none;
		}
	}
</style>
