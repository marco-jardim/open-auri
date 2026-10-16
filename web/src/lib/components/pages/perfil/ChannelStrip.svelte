<script lang="ts">
	// One signed creation as a console channel strip: label scribble on top, license and level
	// readouts, A/B transport at the bottom. User text is interpolated as text only.
	import { m } from '#lib/paraglide/messages.js';
	import { formatDate, formatLevel, type LineageCard } from './model.ts';

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
		/** Side playing for this strip, or null when it is not the one being heard. */
		side?: 'A' | 'B' | null;
		busy?: boolean;
		canPreview?: boolean;
		onListen?: (item: LineageCard, side: 'A' | 'B') => void;
		onStop?: () => void;
	} = $props();
	const id = $props.id();
</script>

<article class="strip" class:live={side !== null} aria-labelledby="{id}-name">
	<header>
		<span class="channel">{String(index + 1).padStart(2, '0')}</span>
		<span class="led" aria-hidden="true"></span>
	</header>
	<h3 id="{id}-name" class="scribble" lang={item.lang}>{item.name}</h3>
	{#if item.description}<p class="description" lang={item.lang}>{item.description}</p>{/if}
	<dl class="readouts">
		<div>
			<dt>{m.perfil_license()}</dt>
			<dd>{item.license}</dd>
		</div>
		<div>
			<dt>{m.perfil_level_label()}</dt>
			<dd>{formatLevel(item.levelDb, locale)} dB</dd>
		</div>
		<div>
			<dt>{m.perfil_date_label()}</dt>
			<dd>
				<time datetime={new Date(item.createdAt).toISOString()}
					>{formatDate(item.createdAt, locale)}</time
				>
			</dd>
		</div>
	</dl>
	{#if item.curated || item.forked}
		<p class="tags">
			{#if item.curated}<span>{m.perfil_curated()}</span>{/if}
			{#if item.forked}<span>{m.perfil_forked()}</span>{/if}
		</p>
	{/if}
	{#if item.author}<p class="credit">
			{m.perfil_by()} <strong>{item.author.displayUsername}</strong>
		</p>{/if}
	<footer class="transport" role="group" aria-label={m.perfil_preview_group()}>
		{#if canPreview}
			<button
				type="button"
				aria-pressed={side === 'A'}
				disabled={busy}
				onclick={() => onListen?.(item, 'A')}>{m.perfil_listen_a()}</button
			>
			<button
				type="button"
				aria-pressed={side === 'B'}
				disabled={busy}
				onclick={() => onListen?.(item, 'B')}>{m.perfil_listen_b()}</button
			>
			{#if side !== null}
				<button type="button" class="stop" onclick={() => onStop?.()}>{m.perfil_stop()}</button>
			{/if}
		{:else}
			<span class="muted">{m.perfil_preview_unavailable()}</span>
		{/if}
	</footer>
</article>

<style>
	.strip {
		display: grid;
		grid-template-rows: auto auto 1fr auto auto auto auto;
		gap: 8px;
		min-width: 0;
		padding: 12px 12px 10px;
		border: 1px solid #0006;
		border-radius: 4px;
		color: #e8e2d4;
		background:
			linear-gradient(180deg, #ffffff10, transparent 30%),
			linear-gradient(90deg, #2a2b2e, #35363a 50%, #2a2b2e);
		box-shadow:
			inset 0 1px #ffffff1a,
			0 6px 18px #0007;
	}
	.strip.live {
		outline: 2px solid #d9a441;
		outline-offset: 1px;
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		font:
			700 11px/1 'Courier Prime',
			monospace;
		letter-spacing: 0.12em;
		color: #b9b2a3;
	}
	.led {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #3b3f36;
		box-shadow: inset 0 1px 2px #000a;
	}
	.live .led {
		background: #ff9d2e;
		box-shadow: 0 0 8px #ff9d2e;
	}
	.scribble {
		margin: 0;
		padding: 6px 8px;
		overflow-wrap: anywhere;
		color: #1d1a14;
		background: #efe6cf;
		border-radius: 2px;
		transform: rotate(-0.6deg);
		font:
			700 15px/1.25 'Courier Prime',
			monospace;
	}
	.description {
		margin: 0;
		overflow-wrap: anywhere;
		white-space: pre-line;
		color: #cfc8b8;
		font-size: 13px;
	}
	.readouts {
		display: grid;
		gap: 4px;
		margin: 0;
		font:
			12px/1.3 'Courier Prime',
			monospace;
	}
	.readouts div {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		padding: 3px 6px;
		background: #111214;
		border-radius: 2px;
	}
	.readouts dt {
		color: #8f897c;
	}
	.readouts dd {
		margin: 0;
		color: #9fe08a;
	}
	.tags {
		display: flex;
		gap: 6px;
		margin: 0;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.tags span {
		padding: 2px 6px;
		border: 1px solid #d9a44188;
		border-radius: 2px;
		color: #d9a441;
	}
	.credit {
		margin: 0;
		font-size: 12px;
		color: #b9b2a3;
		overflow-wrap: anywhere;
	}
	.transport {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.transport button {
		flex: 1 1 auto;
		min-height: 32px;
		padding: 4px 8px;
		border: 1px solid #000;
		border-radius: 3px;
		color: #1d1a14;
		background: linear-gradient(#e9e3d5, #c9c1ae);
		font:
			700 12px/1 'Geist',
			Arial,
			sans-serif;
		cursor: pointer;
	}
	.transport button[aria-pressed='true'] {
		background: linear-gradient(#ffcf7a, #d9a441);
	}
	.transport button:disabled {
		opacity: 0.6;
		cursor: progress;
	}
	.transport button:focus-visible {
		outline: 2px solid #ffcf7a;
		outline-offset: 2px;
	}
	.transport .stop {
		flex: 0 0 auto;
	}
	.muted {
		color: #8f897c;
		font-size: 12px;
	}
	@media (prefers-reduced-motion: reduce) {
		.scribble {
			transform: none;
		}
	}
</style>
