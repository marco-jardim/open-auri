<script lang="ts">
	// The record turn is decorative, not playback or a meter. Its label uses the public curve.
	import MiniCurve from '#lib/charts/MiniCurve.svelte';
	import { Button } from '#lib/components/primitives/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import HideActions from '#lib/components/social/HideActions.svelte';
	import { authorHiddenId } from '#lib/social/hidden.ts';
	import { formatDate, formatLevel, previewCurve, type LineageCard } from './model.ts';

	let {
		item,
		index,
		locale,
		side = null,
		busy = false,
		canPreview = true,
		onListen,
		onStop
	}: {
		item: LineageCard;
		index: number;
		locale: string;
		side?: 'A' | 'B' | null;
		busy?: boolean;
		canPreview?: boolean;
		onListen?: (item: LineageCard, side: 'A' | 'B') => void;
		onStop?: () => void;
	} = $props();
	const id = $props.id();
	const curve = $derived(previewCurve(item.s1));
</script>

<article
	class="record"
	class:playing={side !== null}
	aria-labelledby="{id}-name"
	data-testid="profile-record"
>
	<a
		class="sleeve"
		href={`/c/${encodeURIComponent(item.id)}`}
		aria-labelledby="{id}-name"
		aria-describedby="{id}-open"
	>
		<div class="vinyl" data-testid="profile-vinyl">
			<div class="label">
				<span class="edition" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
				<div class="mini-curve">
					{#if curve}
						<MiniCurve
							{curve}
							minDb={-15}
							maxDb={15}
							label={m.fux_p9_curve_label({ name: item.name })}
							description={m.fux_p9_curve_description()}
						/>
					{:else}
						<span class="unavailable">{m.fux_p9_curve_unavailable()}</span>
					{/if}
				</div>
				<span class="spindle" aria-hidden="true"></span>
			</div>
		</div>
		<span class="open" id="{id}-open"
			>{m.fux_p9_open_curve()} <span aria-hidden="true">↗</span></span
		>
	</a>
	<h3 id="{id}-name" lang={item.lang}>{item.name}</h3>
	{#if item.description}<p class="description" lang={item.lang}>{item.description}</p>{/if}
	<dl class="readouts">
		<div>
			<dt>{m.perfil_license()}</dt>
			<dd>{item.license}</dd>
		</div>
		<div>
			<dt>{m.perfil_level_label()}</dt>
			<dd>{formatLevel(item.levelDb, locale).replace('-', '−')} dB</dd>
		</div>
		<div>
			<dt>{m.perfil_date_label()}</dt>
			<dd>
				<time datetime={new Date(item.createdAt).toISOString()}>
					{formatDate(item.createdAt, locale)}
				</time>
			</dd>
		</div>
	</dl>
	{#if item.curated || item.forked}
		<p class="tags">
			{#if item.curated}<span>{m.perfil_curated()}</span>{/if}
			{#if item.forked}<span>{m.perfil_forked()}</span>{/if}
		</p>
	{/if}
	{#if item.author}
		<p class="credit">{m.perfil_by()} <strong>{item.author.displayUsername}</strong></p>
	{/if}
	<footer class="transport" role="group" aria-label={m.perfil_preview_group()}>
		{#if canPreview && curve}
			<Button
				aria-pressed={side === 'A'}
				disabledReason={busy ? m.fux_p9_preview_busy() : null}
				onclick={() => onListen?.(item, 'A')}>{m.perfil_listen_a()}</Button
			>
			<Button
				aria-pressed={side === 'B'}
				disabledReason={busy ? m.fux_p9_preview_busy() : null}
				onclick={() => onListen?.(item, 'B')}>{m.perfil_listen_b()}</Button
			>
			{#if side !== null}
				<Button variant="ghost" onclick={() => onStop?.()}>{m.perfil_stop()}</Button>
			{/if}
		{:else}
			<span class="muted">{m.perfil_preview_unavailable()}</span>
		{/if}
	</footer>
	<HideActions
		lineageId={item.id}
		author={authorHiddenId(item.author)}
		curveName={item.name}
		authorName={item.author?.displayUsername}
	/>
</article>

<style>
	.record {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		min-width: 0;
		padding: var(--space-4);
		border: 1px solid var(--rule);
		border-radius: var(--rad-lg);
		color: var(--text);
		background: var(--ink-2);
		box-shadow: var(--elev-2);
	}
	.playing {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: var(--focus-offset);
	}
	.sleeve {
		display: grid;
		gap: var(--space-3);
		color: var(--text-2);
		text-decoration: none;
		border-radius: var(--rad-md);
	}
	.sleeve:focus-visible {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: var(--focus-offset);
	}
	.vinyl {
		display: grid;
		place-items: center;
		width: 100%;
		aspect-ratio: 1;
		border-radius: 50%;
		border: 1px solid var(--ink-4);
		background:
			conic-gradient(
				from 25deg,
				transparent,
				var(--rule),
				transparent 24%,
				transparent 50%,
				var(--rule),
				transparent 74%
			),
			repeating-radial-gradient(circle, var(--ink) 0 2px, var(--ink-4) 3px, var(--ink) 4px);
		box-shadow: var(--elev-2), var(--bevel);
		/* Decorative 1/8 turn, once per hover/focus. Never tied to audio, never looping. */
		transition: transform var(--dur-slow) var(--ease-out);
	}
	@media (hover: hover) {
		.sleeve:hover .vinyl {
			transform: rotate(45deg);
		}
	}
	.sleeve:focus-visible .vinyl {
		transform: rotate(45deg);
	}
	.label {
		display: grid;
		place-items: center;
		align-content: center;
		gap: var(--space-1);
		width: 56%;
		aspect-ratio: 1;
		border-radius: 50%;
		color: var(--paper-ink);
		background: var(--paper);
		box-shadow: var(--bevel);
	}
	.edition {
		font: 500 var(--fs-eyebrow) / var(--lh-caps) var(--face-data);
		letter-spacing: var(--tracking-data);
	}
	.mini-curve {
		width: 82%;
	}
	.unavailable {
		display: block;
		font-size: var(--label-min);
		line-height: var(--lh-small);
		text-align: center;
	}
	.spindle {
		width: var(--space-2);
		height: var(--space-2);
		border-radius: 50%;
		background: var(--ink);
	}
	.open {
		display: flex;
		align-items: center;
		justify-content: space-between;
		min-height: var(--hit);
		font-size: var(--fs-ui);
		font-weight: 500;
		text-decoration: underline;
		text-underline-offset: var(--space-1);
	}
	h3 {
		margin: 0;
		font: 400 var(--fs-title) / var(--lh-title) var(--face-display);
		letter-spacing: var(--tracking-title);
		overflow-wrap: anywhere;
	}
	.description {
		margin: 0;
		white-space: pre-line;
		overflow-wrap: anywhere;
		color: var(--text-2);
		font-size: var(--fs-small);
	}
	.readouts {
		display: grid;
		gap: var(--space-2);
		margin: var(--space-2) 0 0;
		font-size: var(--fs-caption);
	}
	.readouts div {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: var(--space-2);
		border-bottom: 1px solid var(--rule);
		padding-bottom: var(--space-1);
	}
	dt {
		color: var(--muted-hi);
	}
	dd {
		margin: 0;
		font-family: var(--face-data);
		font-variant-numeric: tabular-nums slashed-zero;
	}
	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin: 0;
		color: var(--accent-text);
		font-size: var(--fs-caption);
	}
	.credit {
		margin: 0;
		color: var(--text-2);
		font-size: var(--fs-small);
		overflow-wrap: anywhere;
	}
	.transport {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-top: auto;
		padding-top: var(--space-3);
	}
	.muted {
		color: var(--muted-hi);
		font-size: var(--fs-caption);
	}
	@media (prefers-reduced-motion: reduce) {
		.sleeve:hover .vinyl,
		.sleeve:focus-visible .vinyl,
		.sleeve .vinyl {
			transition: none;
			transform: none;
		}
	}
</style>
