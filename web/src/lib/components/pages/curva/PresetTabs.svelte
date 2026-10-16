<!--
	Official presets from `open-auri/catalog`, grouped as preference and reference curves. Labels and
	descriptions come from the catalog (Kuba's descriptions, licence still to be confirmed). Loading a
	preset only changes the editor; nothing is written.
-->
<script lang="ts">
	import { presetsByGroup, type OFFICIAL_PRESETS } from 'open-auri/catalog';
	import { m } from '#lib/paraglide/messages.js';

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
	let focused = $state<string | null>(null);
	const shown = $derived(all.find((preset) => preset.id === (focused ?? activeId)) ?? null);
	const descId = $props.id();

	function description(preset: OfficialPreset): string {
		const english = locale.startsWith('en') ? preset.descriptionEn : null;
		return english ?? preset.description;
	}
</script>

<section class="psec ps-pre" aria-labelledby="{descId}-legend">
	{#each groups as group (group.id)}
		<p class="tabs-cap" id="{descId}-{group.id}">{group.title()}</p>
		<div class="tabs" role="group" aria-labelledby="{descId}-{group.id}">
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
					onpointerleave={() => (focused = null)}>{preset.label}</button
				>
			{/each}
		</div>
	{/each}
	<p class="desc" id={descId} aria-live="polite">
		{#if shown}
			<span>{description(shown)}</span>
			<small>{m.curva_preset_kuba()} · {m.curva_preset_license()}</small>
		{/if}
	</p>
	<h2 class="legend-bar" id="{descId}-legend">{m.curva_presets_heading()}</h2>
</section>

<style>
	.tabs-cap {
		margin: 0 0 6px;
		font: 600 10px/1.2 var(--font-mono, 'JetBrains Mono', monospace);
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--curva-silk-2, #c9c1ae);
	}
	.tabs {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 4px;
		margin-bottom: 10px;
	}
	.tab {
		min-height: 30px;
		padding: 4px 8px;
		border: 1px solid rgb(238 233 222 / 0.22);
		border-radius: 3px;
		background: linear-gradient(#2c2b29, #1d1c1b);
		color: var(--curva-silk, #e9e3d4);
		font: 12px/1.2 var(--font-sans, Geist, system-ui, sans-serif);
		text-align: left;
		cursor: pointer;
	}
	.tab[aria-pressed='true'] {
		border-color: var(--accent, #ff7a2f);
		box-shadow: inset 0 0 0 1px var(--accent, #ff7a2f);
	}
	.tab:focus-visible {
		outline: 2px solid var(--accent, #ff7a2f);
		outline-offset: 2px;
	}
	.desc {
		display: grid;
		gap: 4px;
		min-height: 4.5em;
		margin: 0;
		font-size: 12px;
		color: var(--curva-silk, #e9e3d4);
	}
	.desc small {
		color: var(--curva-silk-2, #c9c1ae);
		font-size: 11px;
	}
</style>
