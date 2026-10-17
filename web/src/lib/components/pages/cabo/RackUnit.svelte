<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		number: string;
		title: string;
		model: string;
		silver?: boolean;
		/** Optional fragment id of the unit (in-page links such as the empty journal's). */
		anchor?: string;
		/** Optional slot after the title (an explainer). */
		aside?: Snippet;
		children: Snippet;
	}
	let { number, title, model, silver = false, anchor, aside, children }: Props = $props();
	const id = $props.id();
</script>

<section class="unit" class:silver aria-labelledby={id} id={anchor}>
	{#each ['tl', 'tr', 'bl', 'br'] as corner (corner)}
		<span class="screw {corner}" aria-hidden="true"></span>
	{/each}
	<span class="handle left" aria-hidden="true"></span>
	<span class="handle right" aria-hidden="true"></span>
	<header>
		<div class="title">
			<h2 {id}><span>{number}</span>{title}</h2>
			{#if aside}{@render aside()}{/if}
		</div>
		<p>{model}</p>
	</header>
	{@render children()}
</section>

<style>
	.unit {
		position: relative;
		z-index: 1;
		margin-bottom: 5px;
		padding: 20px 80px 24px;
		border-radius: 2px;
		color: #d7dbd6;
		background:
			linear-gradient(165deg, #ffffff14, transparent 35%),
			repeating-linear-gradient(90deg, #ffffff06 0 1px, transparent 1px 4px),
			linear-gradient(180deg, #242628, #1a1c1d 60%, #141617);
		box-shadow:
			inset 0 1px #ffffff26,
			inset 0 -2px #000,
			0 6px 14px #000c;
	}
	.silver {
		color: #2a2d2e;
		background:
			linear-gradient(165deg, #ffffff5c, transparent 38%, #00000014),
			repeating-linear-gradient(90deg, #ffffff0e 0 1px, #0000000a 1px 2px, transparent 2px 5px),
			linear-gradient(180deg, #ced1cd, #b5b8b4 55%, #a6a9a5);
		box-shadow:
			inset 0 1px #ffffffa8,
			inset 0 -2px #0000004d,
			0 6px 14px #000c;
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 16px;
		padding-bottom: 10px;
		margin-bottom: 18px;
		border-bottom: 1px solid #ffffff26;
	}
	.silver header {
		border-color: #0003;
	}
	/* The explainer trigger is drawn for dark surfaces: on brushed aluminium it needs dark ink. */
	.silver :global(.trigger) {
		color: #24282a;
	}
	.silver :global(.trigger > span) {
		border-color: rgba(0, 0, 0, 0.55);
	}
	.title {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	h2 {
		display: flex;
		gap: 12px;
		margin: 0;
		font: 600 var(--fs-lede, 17px) / 1.2 var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.18em;
		text-transform: uppercase;
	}
	h2 span {
		font: 11px/1.5 var(--mono, monospace);
		letter-spacing: 0.1em;
	}
	header p {
		margin: 0;
		font: 600 var(--label-min, 11px) / 1.4 var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.12em;
		text-transform: uppercase;
		text-align: right;
	}
	.screw {
		position: absolute;
		width: 13px;
		height: 13px;
		border-radius: 50%;
		background: radial-gradient(circle at 35% 30%, #f4f5f3, #9da19d 45%, #4b4f4c);
		box-shadow:
			0 1px 2px #000a,
			inset 0 0 0 1px #0004;
	}
	.screw::after {
		content: '';
		position: absolute;
		inset: 5.5px 2px;
		background: #3a3d3b;
		transform: rotate(30deg);
	}
	.tl {
		left: 18px;
		top: 11px;
	}
	.tr {
		right: 18px;
		top: 11px;
	}
	.bl {
		left: 18px;
		bottom: 11px;
	}
	.br {
		right: 18px;
		bottom: 11px;
	}
	.handle {
		position: absolute;
		top: 34px;
		bottom: 34px;
		width: 12px;
		border-radius: 6px;
		background: linear-gradient(90deg, #5f6360, #eceeeb 40%, #9a9e9a 70%, #4a4e4b);
		box-shadow: 4px 5px 7px #000b;
	}
	.left {
		left: 42px;
	}
	.right {
		right: 42px;
	}
	@media (max-width: 820px) {
		.unit {
			padding: 18px 32px 22px;
		}
		.handle {
			display: none;
		}
		.tl,
		.bl {
			left: 8px;
		}
		.tr,
		.br {
			right: 8px;
		}
		header {
			flex-wrap: wrap;
			gap: 8px;
		}
		header p {
			text-align: left;
		}
	}
</style>
