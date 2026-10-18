<!--
	Experimentos (Curva side rack, under the presets): curated experimental curves from
	`experiments.ts`. Collapsible and closed by default (the rack is dense); opening it works out,
	one experiment per task, whether each needs Modo YOLO: the core gate in both profiles, never a
	hand-set flag. Each key shows the name, a mini curve of the real response (`miniPath`, as the
	preset cards), "⚠ YOLO" (symbol and text, with a spoken name) when computed, and an info button:
	the "para que serve" and "como montar" text as a tooltip on hover or focus, and inline on press
	(touch); both are linked with aria-describedby, so screen readers reach the text too.
	A press applies through the page (`onapply`: the editor's gated apply, one undo step, the
	filter labels included) unless the layer, the kinds, Modo YOLO or the gate say no; then the
	reason stays in the status line and the editor curve is untouched. Unavailable keys keep focus
	and say why (aria-disabled), like every other control of the page.
	Presentation follows the panel's width (container query): two columns where there is room, one
	row per experiment in a narrow column such as the side rack or a phone.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { m } from '#lib/paraglide/messages.js';
	import Lamp from '#lib/components/primitives/Lamp.svelte';
	import Tooltip from '#lib/components/primitives/Tooltip.svelte';
	import { curveSignature } from '#lib/state/model.ts';
	import type { YoloState } from '#lib/state/yolo.svelte.ts';
	import {
		decideExperiment,
		EXPERIMENTS,
		experimentCurve,
		experimentStatus,
		lockedIn,
		type Experiment,
		type ExperimentId
	} from './experiments.ts';
	import type { Layer } from './layers.ts';
	import { miniPath } from './mini.ts';
	import type { Curve } from './model.ts';
	import { firstReasonText } from './reasons.ts';

	interface Props {
		layer: Layer;
		locale: string;
		/** This tab's Modo YOLO (`app.yolo`, lib/state/yolo.svelte.ts); null before the app mounts. */
		yolo: Pick<YoloState, 'enabled'> | null;
		/** `curveSignature` of the editor curve: lights the experiment the editor holds. */
		signature: string;
		/** Why nothing can be applied yet (the editor is loading), or null. */
		disabledReason?: string | null;
		/** Applies through the page's gated editor path; false when the editor refused it. */
		onapply: (curve: Curve, meta: { name: string; labels: readonly (string | null)[] }) => boolean;
		/** Switches the layer (the "Ir para Engenharia" action). */
		onlayer?: (layer: Layer) => void;
	}
	let { layer, locale, yolo, signature, disabledReason = null, onapply, onlayer }: Props = $props();

	interface Copy {
		name: () => string;
		purpose: () => string;
		howto: () => string;
	}
	const TEXT: Record<ExperimentId, Copy> = {
		solo: {
			name: () => m.curva_xp_solo_name(),
			purpose: () => m.curva_xp_solo_purpose(),
			howto: () => m.curva_xp_solo_howto()
		},
		'radio-am': {
			name: () => m.curva_xp_radio_am_name(),
			purpose: () => m.curva_xp_radio_am_purpose(),
			howto: () => m.curva_xp_radio_am_howto()
		},
		telefone: {
			name: () => m.curva_xp_telefone_name(),
			purpose: () => m.curva_xp_telefone_purpose(),
			howto: () => m.curva_xp_telefone_howto()
		},
		'notch-60': {
			name: () => m.curva_xp_notch_60_name(),
			purpose: () => m.curva_xp_notch_60_purpose(),
			howto: () => m.curva_xp_notch_60_howto()
		},
		'notch-50': {
			name: () => m.curva_xp_notch_50_name(),
			purpose: () => m.curva_xp_notch_50_purpose(),
			howto: () => m.curva_xp_notch_50_howto()
		},
		'vogal-a': {
			name: () => m.curva_xp_vogal_a_name(),
			purpose: () => m.curva_xp_vogal_a_purpose(),
			howto: () => m.curva_xp_vogal_a_howto()
		},
		'vogal-i': {
			name: () => m.curva_xp_vogal_i_name(),
			purpose: () => m.curva_xp_vogal_i_purpose(),
			howto: () => m.curva_xp_vogal_i_howto()
		},
		ressonancia: {
			name: () => m.curva_xp_ressonancia_name(),
			purpose: () => m.curva_xp_ressonancia_purpose(),
			howto: () => m.curva_xp_ressonancia_howto()
		},
		'volume-baixo': {
			name: () => m.curva_xp_volume_baixo_name(),
			purpose: () => m.curva_xp_volume_baixo_purpose(),
			howto: () => m.curva_xp_volume_baixo_howto()
		},
		subsonica: {
			name: () => m.curva_xp_subsonica_name(),
			purpose: () => m.curva_xp_subsonica_purpose(),
			howto: () => m.curva_xp_subsonica_howto()
		},
		'parede-16k': {
			name: () => m.curva_xp_parede_16k_name(),
			purpose: () => m.curva_xp_parede_16k_purpose(),
			howto: () => m.curva_xp_parede_16k_howto()
		},
		escuro: {
			name: () => m.curva_xp_escuro_name(),
			purpose: () => m.curva_xp_escuro_purpose(),
			howto: () => m.curva_xp_escuro_howto()
		},
		claro: {
			name: () => m.curva_xp_claro_name(),
			purpose: () => m.curva_xp_claro_purpose(),
			howto: () => m.curva_xp_claro_howto()
		}
	};

	const uid = $props.id();
	const bodyId = `${uid}-body`;
	const noteId = `${uid}-note`;
	const statusId = `${uid}-status`;
	// Thumbnails and signatures of fixed data, computed once.
	const minis = new Map(EXPERIMENTS.map((x) => [x.id, miniPath(x.bands)]));
	const signatures = new Map(EXPERIMENTS.map((x) => [x.id, curveSignature(experimentCurve(x))]));

	let open = $state(false);
	let expanded = $state<ExperimentId | null>(null);
	/** Computed YOLO-only flags (filled one experiment per task while the section is open). */
	const yoloOnly = new SvelteMap<ExperimentId, boolean>();
	let message = $state.raw<{
		text: string;
		cta: string | null;
		engenharia: boolean;
		tone: 'info' | 'error';
	} | null>(null);

	const yoloOn = $derived(yolo?.enabled ?? false);
	/** Why no key acts in this state (loading, Ouvir), or null. */
	const blockReason = $derived(
		disabledReason?.trim() || (layer === 'ouvir' ? m.curva_xp_ouvir_reason() : null)
	);
	/** The standing note under the toggle: the block reason, or the Ajustar kinds hint. */
	const note = $derived(
		blockReason ?? (layer === 'ajustar' ? m.curva_xp_ajustar_note() : m.curva_xp_intro())
	);

	// The gate runs twice per experiment (standard and YOLO): spread over tasks, never at once.
	$effect(() => {
		if (!open || untrack(() => yoloOnly.size) === EXPERIMENTS.length) return;
		let index = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const step = () => {
			const experiment = EXPERIMENTS[index++];
			if (!experiment) return;
			yoloOnly.set(experiment.id, experimentStatus(experiment).requiresYolo);
			timer = setTimeout(step, 0);
		};
		timer = setTimeout(step, 0);
		return () => clearTimeout(timer);
	});

	/** Whether a press would be refused before the gate (aria-disabled, the reason on press). */
	function unavailable(experiment: Experiment): boolean {
		return (
			blockReason !== null ||
			lockedIn(experiment, layer) ||
			(!yoloOn && yoloOnly.get(experiment.id) === true)
		);
	}
	function tipText(copy: Copy): string {
		return `${m.curva_xp_purpose()} ${copy.purpose()} ${m.curva_xp_howto()} ${copy.howto()}`;
	}
	function say(text: string, tone: 'info' | 'error' = 'info', cta: string | null = null) {
		message = { text, cta, engenharia: layer !== 'engenharia' && cta !== null, tone };
	}

	function press(experiment: Experiment) {
		const name = TEXT[experiment.id].name();
		const loading = disabledReason?.trim();
		if (loading) {
			say(loading);
			return;
		}
		const decision = decideExperiment(experiment, { layer, yoloOn });
		if (decision.ok) {
			if (onapply(decision.curve, { name, labels: decision.labels })) {
				say(m.curva_xp_applied({ name }));
			} else {
				say(m.curva_xp_failed({ name }), 'error');
			}
			return;
		}
		switch (decision.reason) {
			case 'ouvir':
				say(m.curva_xp_ouvir_reason());
				break;
			case 'engenharia':
				say(m.curva_xp_engenharia_reason({ name }), 'info', m.curva_xp_engenharia_cta());
				break;
			case 'yolo': {
				const standard = experimentStatus(experiment).standard;
				const reason = firstReasonText(standard.reasons, { bands: experiment.bands, locale });
				say(m.curva_xp_yolo_reason({ name, reason }), 'info', m.curva_xp_yolo_cta());
				break;
			}
			case 'gate': {
				const reason = firstReasonText(decision.verdict.reasons, {
					bands: experiment.bands,
					locale
				});
				say(m.curva_xp_refused({ name, reason }), 'error');
				break;
			}
		}
	}
</script>

<section class="psec ps-xp" aria-labelledby="{uid}-legend" data-open={open}>
	<button
		type="button"
		class="xp-toggle"
		aria-expanded={open}
		aria-controls={bodyId}
		onclick={() => (open = !open)}
	>
		<span class="xp-chev" aria-hidden="true">▸</span>
		<span>{open ? m.curva_xp_hide() : m.curva_xp_show({ count: String(EXPERIMENTS.length) })}</span>
	</button>
	<div class="xp-body" id={bodyId} hidden={!open}>
		{#if open}
			<p class="xp-note" id={noteId}>{note}</p>
			<ul class="xp-list" aria-labelledby="{uid}-legend">
				{#each EXPERIMENTS as experiment (experiment.id)}
					{@const copy = TEXT[experiment.id]}
					{@const tipId = `${uid}-${experiment.id}-tip`}
					{@const detailId = `${uid}-${experiment.id}-detail`}
					{@const off = unavailable(experiment)}
					{@const active = signatures.get(experiment.id) === signature}
					<li class="xp">
						<button
							type="button"
							class="xp-key"
							aria-pressed={active}
							aria-disabled={off ? 'true' : undefined}
							aria-describedby={off && blockReason !== null ? `${tipId} ${noteId}` : tipId}
							data-experiment={experiment.id}
							onclick={() => press(experiment)}
						>
							<Lamp on={active} class="xp-lamp" />
							<span class="xp-name">
								{copy.name()}
								{#if yoloOnly.get(experiment.id)}
									<span class="xp-yolo" aria-hidden="true">⚠ YOLO</span>
									<span class="sr-only">{m.curva_xp_yolo_marker()}</span>
								{/if}
							</span>
							<svg
								class="xp-mini"
								viewBox="0 0 100 20"
								preserveAspectRatio="none"
								aria-hidden="true"
							>
								<line x1="0" y1="10" x2="100" y2="10" />
								<path d={minis.get(experiment.id) ?? ''} vector-effect="non-scaling-stroke" />
							</svg>
						</button>
						<Tooltip id={tipId} text={tipText(copy)}>
							{#snippet children(tip)}
								<button
									type="button"
									class="xp-info"
									{@attach tip.attach}
									aria-label={m.curva_xp_info({ name: copy.name() })}
									aria-describedby={tip.id}
									aria-expanded={expanded === experiment.id}
									aria-controls={detailId}
									onclick={() => (expanded = expanded === experiment.id ? null : experiment.id)}
								>
									<span aria-hidden="true">i</span>
								</button>
							{/snippet}
						</Tooltip>
						<div class="xp-detail" id={detailId} hidden={expanded !== experiment.id}>
							<p><b>{m.curva_xp_purpose()}</b> {copy.purpose()}</p>
							<p><b>{m.curva_xp_howto()}</b> {copy.howto()}</p>
						</div>
					</li>
				{/each}
			</ul>
			<div class="xp-status" id={statusId} role="status" aria-live="polite">
				{#if message}
					<p class:error={message.tone === 'error'}>{message.text}</p>
					{#if message.cta}
						<p class="xp-cta">{message.cta}</p>
					{/if}
					{#if message.engenharia && onlayer && layer !== 'engenharia'}
						<button type="button" class="btn-pl" onclick={() => onlayer?.('engenharia')}>
							{m.curva_xp_go_engenharia()}
						</button>
					{/if}
				{/if}
			</div>
		{/if}
	</div>
	<h2 class="legend-bar" id="{uid}-legend">{m.curva_xp_heading()}</h2>
</section>

<style>
	.ps-xp {
		container: curva-xp / inline-size;
	}
	.xp-toggle {
		display: flex;
		gap: var(--space-2);
		align-items: center;
		width: 100%;
		min-height: var(--hit);
		margin: var(--space-1) 0 0;
		padding: 4px 2px;
		border: 0;
		background: none;
		color: var(--text-2);
		font: 600 var(--label-min) / var(--lh-caps) var(--face-engrave);
		letter-spacing: 0.2em;
		text-align: left;
		text-transform: uppercase;
		cursor: pointer;
	}
	.xp-toggle::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--rule);
	}
	.xp-toggle:hover {
		color: var(--text);
	}
	.xp-toggle:focus-visible,
	.xp-key:focus-visible,
	.xp-info:focus-visible {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: var(--focus-offset);
	}
	.xp-chev {
		display: inline-block;
		transition: transform var(--dur-fast) var(--ease-out);
	}
	.ps-xp[data-open='true'] .xp-chev {
		transform: rotate(90deg);
	}
	.xp-note {
		margin: var(--space-2) 0 6px;
		color: var(--text-2);
		font: 400 var(--fs-caption) / var(--lh-small) var(--face-body);
	}
	.xp-list {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.xp {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 4px;
		min-width: 0;
	}
	.xp-key {
		display: grid;
		grid-template-columns: 10px minmax(0, 1fr) minmax(56px, 38%);
		column-gap: var(--space-2);
		align-items: center;
		min-width: 0;
		min-height: var(--hit);
		padding: 4px 8px;
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
	.xp-key:hover {
		border-color: var(--rule-control);
	}
	.xp-key[aria-pressed='true'] {
		transform: translateY(2px);
		background: linear-gradient(180deg, #151412, #1d1c19);
		box-shadow:
			var(--well),
			0 1px 0 #050505;
	}
	.xp-key[aria-disabled='true'] {
		cursor: not-allowed;
	}
	.xp-key[aria-disabled='true'] .xp-name {
		color: var(--text-2);
	}
	.xp-key :global(.xp-lamp) {
		width: 7px;
		height: 7px;
	}
	.xp-name {
		display: flex;
		flex-wrap: wrap;
		gap: 2px 6px;
		align-items: baseline;
		min-width: 0;
		font: 600 var(--fs-small) / 1.15 var(--face-engrave);
		letter-spacing: 0.04em;
	}
	.xp-yolo {
		padding: 0 4px;
		border: 1px solid var(--warn);
		border-radius: var(--rad-sm);
		color: var(--warn);
		font: 700 var(--label-min) / 1.3 var(--face-data);
		letter-spacing: 0.06em;
		white-space: nowrap;
	}
	.xp-mini {
		display: block;
		width: 100%;
		height: 18px;
	}
	.xp-mini line {
		stroke: var(--rule);
	}
	.xp-mini path {
		fill: none;
		stroke: var(--text-2);
		stroke-opacity: 0.55;
		stroke-width: 1.2;
	}
	.xp-key[aria-pressed='true'] .xp-mini path {
		stroke: var(--accent);
		stroke-opacity: 1;
		filter: drop-shadow(0 0 3px color-mix(in srgb, var(--accent) 60%, transparent));
	}
	.xp-info {
		display: grid;
		place-items: center;
		width: 32px;
		min-height: var(--hit);
		padding: 0;
		border: 1px solid var(--rule-control);
		border-radius: var(--rad-sm);
		background: linear-gradient(#262725, #141514);
		color: var(--text-2);
		font: italic 700 var(--fs-small) / 1 var(--face-body);
		cursor: help;
	}
	.xp-info[aria-expanded='true'] {
		border-color: color-mix(in srgb, var(--accent) 55%, transparent);
		color: var(--accent-text);
	}
	.xp-detail {
		grid-column: 1 / -1;
		margin: 0 0 4px;
		padding: 6px 8px;
		border-left: 2px solid var(--rule-control);
		color: var(--text);
		font: 400 var(--fs-caption) / var(--lh-small) var(--face-body);
	}
	.xp-detail p {
		margin: 0;
	}
	.xp-detail p + p {
		margin-top: 4px;
	}
	.xp-status {
		display: grid;
		gap: 6px;
		justify-items: start;
		min-height: 1.5em;
		margin-top: var(--space-2);
		color: var(--text);
		font: 400 var(--fs-caption) / var(--lh-small) var(--face-body);
	}
	.xp-status p {
		margin: 0;
	}
	.xp-status .error {
		color: var(--danger);
	}
	.xp-cta {
		font-weight: 600;
	}
	/* Narrow column (side rack, phone): one experiment per row. */
	@container curva-xp (max-width: 360px) {
		.xp-list {
			grid-template-columns: minmax(0, 1fr);
			gap: 4px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.xp-key,
		.xp-chev {
			transition: none;
		}
	}
</style>
