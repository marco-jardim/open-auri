<!--
	Master scope (S4): response overlay of the selected strips against your editor curve, the S4
	distance of the scope target, and A/B listening on the shared audio engine (level matched by
	`createAB`). "Gravar no cabo" only opens the layout's checklist through `requestWrite`.
-->
<script lang="ts">
	import { FREQUENCY_TICKS, dbTicks, frequencyLabel } from '#lib/charts/index.ts';
	import { formatNumber } from '#lib/components/cable/i18n.ts';
	import { m } from '#lib/paraglide/messages.js';
	import type { Listener } from './listener.svelte.ts';
	import {
		SCOPE_BOX,
		avatarHue,
		formatDb,
		formatHz,
		s4,
		scopePath,
		scopeScales,
		type Channel,
		type DecodedCurve
	} from './model.ts';

	let {
		selected,
		editor,
		listener,
		locale,
		canListen,
		onnotice,
		onuse,
		oninstall,
		onopen
	}: {
		selected: Channel[];
		editor: DecodedCurve | null;
		listener: Listener;
		locale: string;
		canListen: boolean;
		onnotice: (message: string) => void;
		onuse: (channel: Channel) => void;
		oninstall: (channel: Channel) => void;
		onopen: (channel: Channel) => void;
	} = $props();

	const id = $props.id();
	let range = $state(12);
	/** B side: 'editor' or the lineage id of another selected strip. */
	let bChoice = $state('editor');

	const target = $derived(selected[0] ?? null);
	const others = $derived(selected.slice(1).filter((channel) => channel.curve !== null));
	const bChannel = $derived(others.find((channel) => channel.lineageId === bChoice) ?? null);
	const scales = $derived(scopeScales(-range, range));
	const ticks = $derived(dbTicks(-range, range, range / 2));
	const reading = $derived(target?.curve && editor ? s4(target.curve, editor) : null);
	const scopeListening = $derived(listener.owner === 'scope');
	const trims = $derived(scopeListening ? listener.trims : null);

	$effect(() => {
		if (bChoice !== 'editor' && !others.some((channel) => channel.lineageId === bChoice)) {
			bChoice = 'editor';
		}
	});

	function bCurve(): { lineageId: string | null; curve: DecodedCurve } | null {
		if (bChannel?.curve) return { lineageId: bChannel.lineageId, curve: bChannel.curve };
		if (editor) return { lineageId: null, curve: editor };
		return null;
	}

	async function toggleListen() {
		if (scopeListening) {
			listener.stop();
			return;
		}
		const b = bCurve();
		if (!target?.curve || !b || !canListen) {
			onnotice(m.comunidade_audio_unavailable());
			return;
		}
		try {
			await listener.play({
				a: { lineageId: target.lineageId, curve: target.curve },
				b,
				initial: 'A',
				owner: 'scope'
			});
			onopen(target);
			if (bChannel) onopen(bChannel);
		} catch (error) {
			onnotice(m.comunidade_audio_error());
			console.warn(
				JSON.stringify({
					event: 'comunidade.scope_listen_failed',
					error: error instanceof Error ? error.name : 'unknown'
				})
			);
		}
	}

	function choose(side: 'A' | 'B') {
		if (scopeListening) listener.select(side);
	}
</script>

<div class="scope-panel">
	<div class="panel-head">
		<h2 id="{id}-title">{m.comunidade_scope_title()}</h2>
		<span class="solo-lamp" class:on={scopeListening} aria-hidden="true">SOLO</span>
	</div>
	<div class="crt">
		<svg
			viewBox="0 0 760 300"
			role="img"
			aria-labelledby="{id}-title {id}-desc"
			data-testid="master-scope"
		>
			<desc id="{id}-desc">{m.comunidade_scope_desc({ count: String(selected.length) })}</desc>
			{#each ticks as tick (tick)}
				<line
					class="gr"
					class:gr0={tick === 0}
					x1={SCOPE_BOX.left}
					x2={SCOPE_BOX.left + SCOPE_BOX.width}
					y1={scales.y(tick)}
					y2={scales.y(tick)}
				/>
				<text class="gt" x="4" y={scales.y(tick) + 4}>{formatNumber(tick, 0, true)}</text>
			{/each}
			{#each FREQUENCY_TICKS as freq (freq)}
				<line
					class="gr"
					x1={scales.x(freq)}
					x2={scales.x(freq)}
					y1={SCOPE_BOX.top}
					y2={SCOPE_BOX.top + SCOPE_BOX.height}
				/>
				<text class="gt" x={scales.x(freq) - 10} y="296">{frequencyLabel(freq, locale)}</text>
			{/each}
			{#if editor}
				<path class="tr-cur" d={scopePath(editor, -range, range)} />
			{/if}
			{#each selected as channel, index (channel.lineageId)}
				{#if channel.curve}
					<path
						class={index === 0 ? 'tr-sel' : 'tr-member'}
						stroke={index === 0 ? undefined : `hsl(${avatarHue(channel.s1)} 80% 70%)`}
						d={scopePath(channel.curve, -range, range)}
						data-testid="scope-trace"
					/>
				{/if}
			{/each}
		</svg>
		<div class="crt-glass" aria-hidden="true"></div>
	</div>
	<ul class="scope-legend">
		{#if target}
			<li><span class="sw sel"></span>{target.name}</li>
		{:else}
			<li class="muted">{m.comunidade_scope_empty()}</li>
		{/if}
		{#each others as channel (channel.lineageId)}
			<li>
				<span class="sw" style:background="hsl({avatarHue(channel.s1)} 80% 70%)"
				></span>{channel.name}
			</li>
		{/each}
		{#if editor}<li><span class="sw cur"></span>{m.comunidade_scope_your_curve()}</li>{/if}
	</ul>
	<div class="scope-row">
		<div class="seg-box">
			<span>{m.comunidade_s4_rms()}</span>
			<output class="seg" data-testid="s4-rms">{reading ? formatDb(reading.rmsDb) : '–'}</output>
		</div>
		<div class="seg-box">
			<span>{m.comunidade_s4_max()}</span>
			<output class="seg">{reading ? formatDb(reading.maxDb) : '–'}</output>
		</div>
		<label class="kctl">
			<span class="k-lbl">{m.comunidade_scope_scale()}</span>
			<select bind:value={range}>
				<option value={6}>±6 dB</option>
				<option value={12}>±12 dB</option>
				<option value={18}>±18 dB</option>
			</select>
		</label>
		{#if reading}
			<p class="cursor-read">{m.comunidade_s4_at({ freq: formatHz(reading.maxFreqHz) })}</p>
		{/if}
	</div>
	<div class="ab-row" role="group" aria-labelledby="{id}-ab">
		<span class="ab-title" id="{id}-ab">{m.comunidade_ab_title()}</span>
		<button
			type="button"
			class="btn ab-play"
			aria-pressed={scopeListening}
			disabled={!target?.curve || listener.busy}
			onclick={toggleListen}>{scopeListening ? m.comunidade_stop() : m.comunidade_listen()}</button
		>
		<span class="push-group">
			<button
				type="button"
				class="push"
				aria-pressed={scopeListening && listener.side === 'A'}
				disabled={!scopeListening}
				onclick={() => choose('A')}>{m.comunidade_ab_a()}</button
			>
			<button
				type="button"
				class="push"
				aria-pressed={scopeListening && listener.side === 'B'}
				disabled={!scopeListening}
				onclick={() => choose('B')}>{m.comunidade_ab_b()}</button
			>
		</span>
		<label class="ab-b">
			<span>{m.comunidade_ab_b_source()}</span>
			<select bind:value={bChoice} disabled={scopeListening}>
				<option value="editor">{m.comunidade_scope_your_curve()}</option>
				{#each others as channel (channel.lineageId)}
					<option value={channel.lineageId}>{channel.name}</option>
				{/each}
			</select>
		</label>
		<span class="ab-read" aria-live="polite">
			{#if trims}
				{m.comunidade_ab_matched({
					a: formatNumber(trims[0], 1, true),
					b: formatNumber(trims[1], 1, true)
				})}
			{:else}
				{m.comunidade_ab_note()}
			{/if}
		</span>
	</div>
	{#if target}
		<div class="scope-actions">
			<a class="btn" href="/#p={target.s1}" data-sveltekit-reload onclick={() => onopen(target)}
				>{m.comunidade_open_curva()}</a
			>
			<button type="button" class="btn" onclick={() => onuse(target)}
				>{m.comunidade_use_curve()}</button
			>
			<button type="button" class="btn primary" onclick={() => oninstall(target)}
				>{m.comunidade_install()}</button
			>
		</div>
		<p class="note">{m.comunidade_install_note()}</p>
	{/if}
</div>

<style>
	.panel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 10px;
	}
	.panel-head h2 {
		font: italic 30px/1 var(--serif);
		margin: 0;
	}
	.solo-lamp {
		font: 700 11px var(--mono);
		letter-spacing: 0.12em;
		padding: 4px 9px;
		border-radius: 3px;
		background: #2b2516;
		color: #a8925a;
		border: 1px solid #000;
	}
	.solo-lamp.on {
		background: radial-gradient(circle, #fff3c4, #ffc248 70%);
		color: #2a1d05;
		box-shadow: 0 0 14px #ffc24888;
	}
	.crt {
		position: relative;
		border-radius: 20px;
		padding: 13px;
		background: linear-gradient(145deg, #55585c, #26282b 60%, #1d1e20);
		box-shadow:
			inset 0 2px 0 #ffffff26,
			inset 0 -2px 0 #000,
			0 12px 26px #000b;
	}
	.crt svg {
		display: block;
		width: 100%;
		height: auto;
		border-radius: 12px;
		background: radial-gradient(120% 110% at 50% 45%, #0f1913, #050806 80%);
		box-shadow: inset 0 0 50px #000;
	}
	.crt-glass {
		position: absolute;
		inset: 13px;
		border-radius: 12px;
		pointer-events: none;
		background:
			linear-gradient(128deg, #ffffff16, transparent 32%),
			repeating-linear-gradient(0deg, #0000002e 0 1px, transparent 1px 3px);
	}
	.gr {
		stroke: #5f9a7c3d;
		stroke-width: 1;
	}
	.gr0 {
		stroke: #7fbf9e99;
	}
	.gt {
		fill: #b5d8c6;
		font: 12px var(--mono);
	}
	.tr-cur {
		fill: none;
		stroke: var(--ice);
		stroke-width: 2;
		stroke-dasharray: 6 4;
	}
	.tr-sel {
		fill: none;
		stroke: var(--amber);
		stroke-width: 2.4;
	}
	.tr-member {
		fill: none;
		stroke-width: 1.4;
		opacity: 0.8;
	}
	.scope-legend {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 20px;
		font: 12px var(--mono);
		color: #ece7dd;
		margin: 12px 2px;
		padding: 0;
		list-style: none;
	}
	.scope-legend li {
		overflow-wrap: anywhere;
	}
	.muted {
		color: #c9c4b9;
	}
	.sw {
		display: inline-block;
		width: 20px;
		height: 3px;
		vertical-align: 3px;
		margin-right: 6px;
	}
	.sw.sel {
		background: var(--amber);
	}
	.sw.cur {
		background: repeating-linear-gradient(90deg, var(--ice) 0 5px, transparent 5px 8px);
	}
	.scope-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 14px;
		margin: 6px 0 12px;
	}
	.seg-box {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.seg-box span,
	.k-lbl {
		font: 600 11px var(--mono);
		letter-spacing: 0.06em;
		color: #e4e0d6;
	}
	.seg {
		font: 500 24px var(--mono);
		font-variant-numeric: tabular-nums;
		color: var(--amber);
		background: #110b04;
		padding: 3px 10px;
		border-radius: 3px;
		box-shadow:
			inset 0 2px 6px #000,
			0 1px 0 #ffffff14;
		min-width: 128px;
		text-align: right;
	}
	.kctl {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	select {
		background: #0a0a0b;
		color: #ffdca6;
		border: 1px solid #000;
		padding: 4px 6px;
		font: 12px var(--mono);
		border-radius: 2px;
	}
	.cursor-read {
		margin: 0;
		font: 12px/1.6 var(--mono);
		color: #ece7dd;
	}
	.ab-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
		margin: 0 0 14px;
		padding: 10px 12px;
		background: #17181a;
		border: 1px solid #000;
		border-radius: 4px;
	}
	.ab-title {
		font: 600 11px var(--mono);
		letter-spacing: 0.08em;
		color: #e4e0d6;
	}
	.ab-b {
		display: flex;
		align-items: center;
		gap: 6px;
		font: 11px var(--mono);
		color: #d6d2c8;
	}
	.ab-read {
		font: 12px/1.5 var(--mono);
		color: #ece7dd;
		flex: 1;
		min-width: 220px;
	}
	.scope-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.note {
		font-size: 11px;
		line-height: 1.6;
		color: #a99f90;
		margin: 8px 0 0;
	}
</style>
