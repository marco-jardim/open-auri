<!--
	WebHID state diagram of U1 (FUX.P6, mock `cabo-u1-detail.png`). The lit node is the real
	service state, projected by `rackState` → `diagramNode` (model.ts); nothing here keeps a
	second state machine. The edges are drawn in SVG; the nodes are an ordered list so screen
	readers and tests read the same current step (`aria-current="step"`).
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { DIAGRAM_NODES, type DiagramNode } from './model.ts';

	interface Props {
		current: DiagramNode;
		/** The last attempt reached its commit: the "written" node keeps a dim trace. */
		written?: boolean;
		labels: Record<DiagramNode, string>;
	}

	let { current, written = false, labels }: Props = $props();

	const W = 560;
	const H = 196;
	const POSITION: Record<DiagramNode, { x: number; y: number }> = {
		unsupported: { x: 48, y: 40 },
		disconnected: { x: 168, y: 40 },
		connecting: { x: 270, y: 40 },
		connected: { x: 372, y: 40 },
		writing: { x: 494, y: 40 },
		written: { x: 494, y: 138 },
		interrupted: { x: 168, y: 138 }
	};
	const ERROR_NODES: readonly DiagramNode[] = ['unsupported', 'interrupted'];
	const left = (node: DiagramNode) => `${(POSITION[node].x / W) * 100}%`;
	const top = (node: DiagramNode) => `${(POSITION[node].y / H) * 100}%`;
</script>

<div class="diagram">
	<div class="stage">
		<svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false">
			<defs>
				<marker
					id="cabo-arrow"
					viewBox="0 0 6 6"
					refX="5"
					refY="3"
					markerWidth="6"
					markerHeight="6"
					orient="auto"
				>
					<path d="M0 0L6 3L0 6z" fill="#3b3f40" />
				</marker>
			</defs>
			<g class="edges" marker-end="url(#cabo-arrow)">
				<path d="M182 40H254" />
				<path d="M284 40H356" />
				<path d="M386 40H478" />
				<path d="M494 56V120" />
				<path d="M478 138H388Q372 138 372 124V58" />
				<path class="dashed" d="M510 40H544V180H184Q168 180 168 168V156" />
				<path d="M152 138H128Q116 138 116 126V52Q116 40 128 40H150" />
			</g>
			<g class="edge-labels">
				<text x="218" y="22" text-anchor="middle">requestDevice</text>
				<text x="432" y="22" text-anchor="middle">{m.cabo_fux_edge_write()}</text>
				<text x="502" y="92">{m.cabo_fux_edge_time()}</text>
				<text x="356" y="174" text-anchor="middle">{m.cabo_fux_edge_drop()}</text>
			</g>
		</svg>
		<ol class="nodes" aria-label={m.cabo_state_machine()}>
			{#each DIAGRAM_NODES as node (node)}
				<li
					data-state={node}
					aria-current={current === node ? 'step' : undefined}
					class:error={ERROR_NODES.includes(node)}
					class:on={current === node}
					class:trace={node === 'written' && written && current !== node}
					style:left={left(node)}
					style:top={top(node)}
				>
					<span class="node-lamp" aria-hidden="true"></span>
					<span class="node-label"
						>{labels[node]}{#if node === 'unsupported'}
							<span class="sub">{m.cabo_fux_state_real_mode()}</span>{/if}</span
					>
				</li>
			{/each}
		</ol>
	</div>
</div>

<style>
	.diagram {
		container-type: inline-size;
		min-width: 0;
	}
	.stage {
		position: relative;
		aspect-ratio: 560 / 196;
	}
	svg {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
	}
	.edges path {
		fill: none;
		stroke: #3b3f40;
		stroke-width: 1.6;
	}
	.edges .dashed {
		stroke-dasharray: 4 3;
	}
	.edge-labels text {
		font: 500 12.5px var(--face-data, 'JetBrains Mono', monospace);
		fill: #2f3335;
	}
	.nodes {
		position: absolute;
		inset: 0;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.nodes li {
		position: absolute;
		display: grid;
		justify-items: center;
		gap: 4px;
		width: 96px;
		transform: translate(-50%, -11px);
		text-align: center;
	}
	.node-lamp {
		display: block;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: radial-gradient(circle at 35% 30%, #5b6766, #101514 75%);
		box-shadow:
			0 0 0 2px #0b0c0c,
			0 0 0 3.5px #8d918d;
		transition:
			background-color var(--dur-base, 0.2s) var(--ease-out, ease-out),
			box-shadow var(--dur-base, 0.2s) var(--ease-out, ease-out);
	}
	.on .node-lamp {
		background: radial-gradient(circle at 35% 30%, #f1fffd, #86e8de 30%, #4fd1c5 60%, #1b7f76);
		box-shadow:
			0 0 0 2px #0b0c0c,
			0 0 0 3.5px #8d918d,
			0 0 12px 2px #4fd1c5aa,
			0 0 28px #4fd1c555;
	}
	.error.on .node-lamp {
		background: radial-gradient(circle at 35% 30%, #ffeaea, #ff9396 30%, #e5484d 60%, #8f1d22);
		box-shadow:
			0 0 0 2px #0b0c0c,
			0 0 0 3.5px #8d918d,
			0 0 12px 2px #e5484daa;
	}
	.trace .node-lamp {
		background: radial-gradient(circle at 35% 30%, #c9efe9, #3f8f87 70%);
	}
	.node-label {
		display: grid;
		font: 600 var(--label-min, 11px) / 1.2 var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: #24282a;
		text-shadow: 0 1px 0 #ffffff8c;
	}
	.sub {
		font: 400 var(--label-min, 11px) var(--face-data, 'JetBrains Mono', monospace);
		letter-spacing: 0;
		text-transform: none;
	}
	@container (max-width: 470px) {
		.stage {
			aspect-ratio: auto;
		}
		svg {
			display: none;
		}
		.nodes {
			position: static;
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 12px;
		}
		.nodes li {
			position: static;
			display: flex;
			align-items: center;
			gap: 8px;
			width: auto;
			transform: none;
			text-align: left;
		}
		.node-lamp {
			flex: none;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.node-lamp {
			transition: none;
		}
	}
</style>
