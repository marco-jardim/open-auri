<!--
	Rotary layer selector (mock v2 .mode-sel): one chicken-head knob with OUVIR, AJUSTAR and
	ENGENHARIA engraved around it and a lamp on the active layer.
	- Keyboard: a radiogroup with roving focus; arrows (and Home/End) move between layers, 1/2/3 are
	  handled by the page. The labels are the radios.
	- Pointer: clicking the knob turns it to the next layer (a shortcut; the radios stay the control).
	- Motion: the knob swings with the mechanical detent easing (--ease-mech); no motion under
	  prefers-reduced-motion. The lamp reflects the real current layer.
	- `children`: controls that belong with the choice of layer (the Modo YOLO switch), under the
	  description and the key hint.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { Explainer } from '#lib/components/comprehension/index.ts';
	import Lamp from '#lib/components/primitives/Lamp.svelte';
	import { LAYERS, layerRank, type Layer } from './layers.ts';

	interface Props {
		layer: Layer;
		onlayer: (layer: Layer) => void;
		/** Layer-bound controls (the Modo YOLO switch), shown under the description. */
		children?: Snippet;
	}
	let { layer, onlayer, children }: Props = $props();

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
	const uid = $props.id();
	const descId = `${uid}-desc`;
	const turn = $derived((layerRank(layer) - 1) * 45);

	function select(next: Layer) {
		onlayer(next);
		buttons[LAYERS.indexOf(next)]?.focus();
	}

	function onkeydown(event: KeyboardEvent, index: number) {
		let next: Layer | undefined;
		if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
			next = LAYERS[(index + 1) % LAYERS.length];
		} else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
			next = LAYERS[(index - 1 + LAYERS.length) % LAYERS.length];
		} else if (event.key === 'Home') {
			next = LAYERS[0];
		} else if (event.key === 'End') {
			next = LAYERS[LAYERS.length - 1];
		}
		if (!next) return;
		event.preventDefault();
		select(next);
	}

	/** Pointer shortcut on the knob face: one detent to the next layer (keyboard uses the radios). */
	function dialClick(node: HTMLElement) {
		const onclick = () => {
			const next = LAYERS[(LAYERS.indexOf(layer) + 1) % LAYERS.length];
			if (next) onlayer(next);
		};
		node.addEventListener('click', onclick);
		return () => node.removeEventListener('click', onclick);
	}
</script>

<div class="mode" data-tour="curva-layers">
	<div
		class="mode-sel"
		role="radiogroup"
		aria-label={m.curva_layer_aria()}
		aria-describedby={descId}
	>
		<div class="dial" aria-hidden="true" {@attach dialClick}>
			<svg viewBox="-60 -60 120 120">
				<defs>
					<radialGradient id="{uid}-skirt" cx="40%" cy="35%" r="70%">
						<stop offset="0" stop-color="#3a3b3a" />
						<stop offset="0.6" stop-color="#151616" />
						<stop offset="1" stop-color="#050505" />
					</radialGradient>
					<linearGradient id="{uid}-face" x1="0" y1="0" x2="1" y2="1">
						<stop offset="0" stop-color="#3d3e3d" />
						<stop offset="1" stop-color="#121212" />
					</linearGradient>
				</defs>
				<g class="scale">
					<line x1="-36" y1="-36" x2="-42" y2="-42" />
					<line x1="0" y1="-52" x2="0" y2="-58" />
					<line x1="36" y1="-36" x2="42" y2="-42" />
				</g>
				<circle cx="4" cy="6" r="44" class="shadow" />
				<circle r="45" fill="url(#{uid}-skirt)" class="skirt" />
				<g class="pointer" style:--turn={`${turn}deg`}>
					<path
						d="M0 -50 C9 -50 14 -20 16 0 C18 22 12 36 0 36 C-12 36 -18 22 -16 0 C-14 -20 -9 -50 0 -50 Z"
						fill="url(#{uid}-face)"
						class="face"
					/>
					<line x1="0" y1="-44" x2="0" y2="-14" class="index" />
				</g>
			</svg>
		</div>
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
				<Lamp on={option === layer} class="mode-lamp" />{labels[option]()}
			</button>
		{/each}
	</div>
	<div class="mode-side">
		<p class="mode-desc" id={descId}>{descriptions[layer]()}</p>
		<div class="keyhint">
			<span><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> {m.curva_keys_hint()}</span>
			<Explainer term="camadas" />
		</div>
		{#if children}
			{@render children()}
		{/if}
	</div>
</div>

<style>
	.mode {
		display: flex;
		gap: var(--space-4);
		align-items: center;
	}
	.mode-sel {
		position: relative;
		flex: none;
		width: 320px;
		height: 140px;
	}
	.dial {
		position: absolute;
		top: 30px;
		left: calc(50% - 50px);
		width: 100px;
		height: 100px;
		border-radius: 50%;
		cursor: pointer;
	}
	.dial svg {
		display: block;
		width: 100%;
		height: 100%;
		overflow: visible;
	}
	.scale line {
		stroke: var(--text);
		stroke-width: 2.4;
	}
	.shadow {
		fill: rgb(0 0 0 / 0.5);
	}
	.skirt,
	.face {
		stroke: #000;
	}
	.index {
		stroke: var(--text);
		stroke-width: 3.4;
		stroke-linecap: round;
	}
	.pointer {
		transform: rotate(var(--turn));
		transition: transform var(--dur-scene) var(--ease-mech);
	}
	.mode-lbl {
		position: absolute;
		display: inline-flex;
		gap: var(--space-2);
		align-items: center;
		min-height: var(--hit);
		padding: 4px 6px;
		border: 0;
		border-radius: var(--rad-sm);
		background: none;
		color: var(--text-2);
		font: 600 var(--fs-small) / 1 var(--face-engrave);
		letter-spacing: 0.2em;
		text-transform: uppercase;
		cursor: pointer;
		transition: color var(--dur-fast) var(--ease-out);
	}
	.mode-lbl:hover {
		color: var(--text);
	}
	.mode-lbl[aria-checked='true'] {
		color: var(--text);
	}
	.mode-lbl :global(.mode-lamp) {
		width: 7px;
		height: 7px;
	}
	.mode-lbl:not([aria-checked='true']) :global(.mode-lamp) {
		visibility: hidden;
	}
	.mode-lbl:focus-visible {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: 2px;
	}
	.l0 {
		top: 40px;
		left: 0;
	}
	.l1 {
		top: -6px;
		left: 50%;
		transform: translateX(-50%);
	}
	.l2 {
		top: 40px;
		right: 0;
	}
	.mode-side {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		max-width: 240px;
	}
	.mode-desc {
		min-height: 3.6em;
		margin: 0;
		color: var(--text-2);
		font: 400 var(--fs-small) / var(--lh-small) var(--face-body);
	}
	.keyhint {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		align-items: center;
		margin: 0;
		color: var(--muted);
		font: 400 var(--fs-caption) / var(--lh-small) var(--face-data);
	}
	kbd {
		padding: 0 4px;
		border: 1px solid var(--rule-control);
		border-radius: var(--rad-sm);
		color: var(--text-2);
		font: inherit;
	}
	@media (prefers-reduced-motion: reduce) {
		.pointer,
		.mode-lbl {
			transition: none;
		}
	}
	@media (max-width: 720px) {
		.mode {
			flex-direction: column;
			align-items: stretch;
		}
		.mode-sel {
			margin: 0 auto;
			max-width: 100%;
		}
		.mode-side {
			max-width: none;
		}
		.mode-desc {
			min-height: 0;
		}
	}
</style>
