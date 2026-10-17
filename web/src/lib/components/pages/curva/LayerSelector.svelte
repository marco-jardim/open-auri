<!--
	Rotary layer selector (Ouvir ⊂ Ajustar ⊂ Engenharia). A radiogroup with roving focus: arrows move
	between layers, 1/2/3 are handled by the page. The knob turns with a CSS transition that is
	removed under prefers-reduced-motion.
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { LAYERS, layerRank, type Layer } from './layers.ts';

	interface Props {
		layer: Layer;
		onlayer: (layer: Layer) => void;
	}
	let { layer, onlayer }: Props = $props();

	const labels: Record<Layer, () => string> = {
		ouvir: () => m.curva_layer_ouvir(),
		ajustar: () => m.curva_layer_ajustar(),
		engenharia: () => m.curva_layer_engenharia()
	};
	const descriptions: Record<Layer, () => string> = {
		ouvir: () => m.curva_layer_desc_ouvir(),
		ajustar: () => m.curva_layer_desc_ajustar(),
		engenharia: () => m.curva_layer_desc_engenharia()
	};
	const buttons = $state<HTMLButtonElement[]>([]);
	const descId = $props.id();

	function onkeydown(event: KeyboardEvent, index: number) {
		const delta =
			event.key === 'ArrowRight' || event.key === 'ArrowDown'
				? 1
				: event.key === 'ArrowLeft' || event.key === 'ArrowUp'
					? -1
					: 0;
		if (delta === 0) return;
		event.preventDefault();
		const next = LAYERS[(index + delta + LAYERS.length) % LAYERS.length];
		if (!next) return;
		onlayer(next);
		buttons[LAYERS.indexOf(next)]?.focus();
	}
</script>

<div class="mode">
	<div
		class="mode-sel"
		role="radiogroup"
		aria-label={m.curva_layer_aria()}
		aria-describedby={descId}
	>
		<svg class="dial" viewBox="-60 -60 120 120" aria-hidden="true">
			<g class="scale">
				<line x1="-36" y1="-36" x2="-42" y2="-42" />
				<line x1="0" y1="-52" x2="0" y2="-58" />
				<line x1="36" y1="-36" x2="42" y2="-42" />
			</g>
			<circle r="45" class="skirt" />
			<g class="pointer" style:--turn={`${(layerRank(layer) - 1) * 45}deg`}>
				<path
					d="M0 -50 C9 -50 14 -20 16 0 C18 22 12 36 0 36 C-12 36 -18 22 -16 0 C-14 -20 -9 -50 0 -50 Z"
					class="face"
				/>
				<line x1="0" y1="-44" x2="0" y2="-14" class="index" />
			</g>
		</svg>
		{#each LAYERS as option, index (option)}
			<button
				bind:this={buttons[index]}
				type="button"
				role="radio"
				class="mode-lbl l{index}"
				aria-checked={option === layer}
				tabindex={option === layer ? 0 : -1}
				onclick={() => onlayer(option)}
				onkeydown={(event) => onkeydown(event, index)}
			>
				{labels[option]()}
			</button>
		{/each}
	</div>
	<div class="mode-side">
		<p class="mode-desc" id={descId}>{descriptions[layer]()}</p>
		<span class="keyhint"><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> {m.curva_keys_hint()}</span>
	</div>
</div>

<style>
	.mode {
		display: flex;
		gap: 18px;
		align-items: center;
	}
	.mode-sel {
		position: relative;
		display: grid;
		grid-template-columns: repeat(3, auto);
		grid-template-rows: auto auto;
		justify-items: center;
		gap: 4px 10px;
		padding: 6px 10px;
	}
	.dial {
		grid-column: 1 / -1;
		width: 84px;
		height: 84px;
	}
	.scale line {
		stroke: var(--curva-silk, #e9e3d4);
		stroke-width: 2.4;
	}
	.skirt {
		fill: #121212;
		stroke: #000;
	}
	.face {
		fill: #262727;
		stroke: #000;
	}
	.index {
		stroke: #f6f2e8;
		stroke-width: 3.4;
		stroke-linecap: round;
	}
	.pointer {
		transform: rotate(var(--turn));
		/* Mock: the mode dial swings to the selected layer in .55 s. */
		transition: transform 550ms cubic-bezier(0.3, 1.4, 0.5, 1);
	}
	.mode-lbl {
		min-height: 32px;
		padding: 4px 8px;
		border: 1px solid transparent;
		border-radius: 3px;
		background: #1d1c1b;
		color: var(--curva-silk-2, #c9c1ae);
		font: 600 11px/1.2 var(--font-mono, 'JetBrains Mono', monospace);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		cursor: pointer;
	}
	.mode-lbl[aria-checked='true'] {
		border-color: var(--accent, #ff7a2f);
		color: var(--accent, #ff7a2f);
	}
	.mode-lbl:focus-visible {
		outline: 2px solid var(--accent, #ff7a2f);
		outline-offset: 2px;
	}
	.mode-side {
		display: flex;
		flex-direction: column;
		gap: 6px;
		max-width: 300px;
	}
	.mode-desc {
		margin: 0;
		font-size: 13px;
		color: var(--curva-silk, #e9e3d4);
	}
	.keyhint {
		font: 11px/1.3 var(--font-mono, 'JetBrains Mono', monospace);
		color: var(--curva-silk-2, #c9c1ae);
	}
	kbd {
		padding: 0 4px;
		border: 1px solid currentColor;
		border-radius: 3px;
	}
	@media (prefers-reduced-motion: reduce) {
		.pointer {
			transition: none;
		}
	}
	@media (max-width: 720px) {
		.mode {
			flex-direction: column;
			align-items: stretch;
		}
		.mode-side {
			max-width: none;
		}
	}
</style>
