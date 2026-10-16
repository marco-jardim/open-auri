<script lang="ts">
	import { onDestroy } from 'svelte';
	import { curveResponseDb, encodePayload, levelDb } from 'open-auri/dsp';
	import { numberLabel } from '#lib/charts/scales.ts';
	import { createSolverWorker } from '#lib/workers/solver-client.ts';
	import { createGateWorker } from '#lib/workers/gate-client.ts';
	import type { ClientApp } from '#lib/app/client.svelte.ts';
	import { solveBlend, type BlendResult } from './blend.ts';
	import { blendTarget, type Track, type NamedCurve } from './comparison.ts';
	import ComparisonPlot from './ComparisonPlot.svelte';
	import { reasonText, type Copy } from './copy.ts';

	let {
		tracks,
		t,
		locale,
		app,
		onBounce
	}: {
		tracks: readonly Track[];
		t: Copy;
		locale: 'pt-BR' | 'en-US';
		app: ClientApp | null;
		onBounce: (id: number, curve: NamedCurve) => void;
	} = $props();
	let before = $state(1);
	let after = $state(2);
	let baseId = $state(1);
	let percent = $state(100);
	let automatic = $state(true);
	let preampDb = $state(-6);
	let bounceId = $state(8);
	let result = $state.raw<BlendResult | null>(null);
	let busy = $state(false);
	let error = $state('');
	let status = $state('');
	let resultSignature = $state('');
	let generation = 0;
	let solver: ReturnType<typeof createSolverWorker> | undefined;
	let gate: ReturnType<typeof createGateWorker> | undefined;
	const a = $derived(tracks.find((track) => track.id === before)!.curve);
	const b = $derived(tracks.find((track) => track.id === after)!.curve);
	const base = $derived(tracks.find((track) => track.id === baseId)!.curve);
	const signature = $derived(JSON.stringify([a, b, base, percent, automatic, preampDb]));
	const target = $derived(blendTarget(base, a, b, percent));
	const fresh = $derived(resultSignature === signature ? result : null);
	const accepted = $derived(fresh?.ok ? fresh : null);
	const payload = $derived(
		accepted ? encodePayload(accepted.curve.bands, accepted.curve.preampDb) : null
	);
	const crc = $derived(
		payload ? ((payload[219] << 8) | payload[218]).toString(16).toUpperCase().padStart(4, '0') : ''
	);
	$effect(() => {
		if (!signature) return;
		generation++;
		busy = false;
		error = '';
		status = '';
		solver?.cancel();
		gate?.cancel();
	});
	onDestroy(() => {
		generation++;
		solver?.dispose();
		gate?.dispose();
	});

	async function calculate() {
		const token = ++generation;
		const currentSignature = signature;
		busy = true;
		error = '';
		status = '';
		try {
			solver ??= createSolverWorker();
			gate ??= createGateWorker();
			const next = await solveBlend(
				{ base, a, b, percent, preampDb: automatic ? null : preampDb, name: t.newName },
				solver,
				gate
			);
			if (token !== generation || currentSignature !== signature) return;
			result = next;
			resultSignature = currentSignature;
		} catch (cause) {
			if (token === generation) {
				console.error('Comparison blend failed', cause);
				error = t.failed;
				result = null;
			}
		} finally {
			if (token === generation) busy = false;
		}
	}

	async function save() {
		if (!accepted || !app) return;
		try {
			const saved = await app.state.library.save(accepted.curve);
			if (!saved) throw new Error('Library refused the comparison curve');
			status = t.saved;
		} catch (cause) {
			console.error('Comparison save failed', cause);
			error = t.failed;
		}
	}

	function open(event: MouseEvent) {
		if (!accepted || !app) {
			event.preventDefault();
			return;
		}
		if (!app.state.curve.set(accepted.curve)) {
			event.preventDefault();
			error = t.failed;
		}
	}
</script>

<section class="panel" id="comparar-blend" aria-labelledby="comparar-blend-title">
	<h2 class="plate" id="comparar-blend-title">{t.blend}</h2>
	<p class="note">{t.blendNote}</p>
	<div class="grid-sos">
		<div>
			<div class="headblock">
				<svg viewBox="0 0 600 160" role="img" aria-label={t.heads}>
					<title>{t.heads}</title>
					<path d="M90 55 C90 5 380 5 380 55" fill="none" stroke="#f2b33d" stroke-dasharray="5 5" />
					<text x="240" y="24" text-anchor="middle" fill="#f2b33d" font-size="17">+ k × Δ</text>
					<path d="M20 115 H580" stroke="#785030" stroke-width="7" />
					{#each [70, 210, 350, 490] as x, index (x)}
						<path
							d="M{x} 55 h50 v38 q0 16 -25 16 q-25 0 -25 -16z"
							fill="url(#comparar-head)"
							stroke={index === 0 ? '#f2b33d' : '#141810'}
							stroke-width="2"
						/>
					{/each}
					<text x="95" y="145" fill="#e9e4d6" text-anchor="middle" font-size="13"
						>{t.base.split(' · ')[0]}</text
					>
					<text x="375" y="145" fill="#e9e4d6" text-anchor="middle" font-size="13"
						>base + k × Δ</text
					>
					<text x="515" y="145" fill="#e9e4d6" text-anchor="middle" font-size="13">{t.result}</text>
				</svg>
			</div>
			<div class="formula">
				<span class="plate metal">Δ = B − A</span><span class="plate metal">base + k × Δ</span>
			</div>
			<div class="sos-controls">
				<label class="field">
					{t.before}
					<select bind:value={before}>
						{#each tracks as track (track.id)}
							<option value={track.id}>{track.id} · {track.curve.name}</option>
						{/each}
					</select>
				</label>
				<label class="field">
					{t.after}
					<select bind:value={after}>
						{#each tracks as track (track.id)}
							<option value={track.id}>{track.id} · {track.curve.name}</option>
						{/each}
					</select>
				</label>
				<label class="field">
					{t.base}
					<select bind:value={baseId}>
						{#each tracks as track (track.id)}
							<option value={track.id}>{track.id} · {track.curve.name}</option>
						{/each}
					</select>
				</label>
				<p class="note">{t.exact}</p>
			</div>
			<div class="sos-knobs">
				<label class="knob-control">
					<span class="knob" style:--angle={`${-135 + percent * 1.8}deg`} aria-hidden="true"
						><span></span></span
					>
					<span class="readout">{numberLabel(percent, locale)} %</span><span class="knob-label"
						>{t.mix}</span
					>
					<input type="range" min="0" max="150" step="1" bind:value={percent} aria-label={t.mix} />
				</label>
				<div class="pre-control">
					<label class="field"
						>{t.preamp}<input
							type="number"
							min="-25.5"
							max="-0.5"
							step="0.1"
							bind:value={preampDb}
							disabled={automatic}
						/></label
					>
					<label class="check"><input type="checkbox" bind:checked={automatic} />{t.auto}</label>
				</div>
			</div>
			<button type="button" class="abtn primary" disabled={busy} onclick={calculate}
				>{busy ? t.busy : t.solve}</button
			>
		</div>
		<div class="result-column">
			<ComparisonPlot
				label={t.blend}
				description={t.blendNote}
				{locale}
				lines={[
					{ name: t.target, values: target, color: '#d3c6ac', dashed: true },
					...(accepted
						? [{ name: t.result, values: curveResponseDb(accepted.curve), color: '#f2b33d' }]
						: [])
				]}
			/>
			<div
				class="verdict"
				class:ok={accepted !== null}
				class:bad={fresh?.ok === false || error !== ''}
				role="status"
				aria-live="polite"
			>
				<span class="lamp" aria-hidden="true"></span>
				<div>
					<strong
						>{busy
							? t.busy
							: error || (accepted ? t.ready : fresh?.ok === false ? t.refused : t.pending)}</strong
					><small>{t.gateNote}</small>
					{#if fresh?.ok === false}
						<ul class="reasons">
							{#each fresh.reasons as reason (`${reason.code}:${reason.stage ?? ''}`)}
								<li>
									{reasonText(reason.code, t)} <code>{reason.code}</code>
									{reason.stage !== undefined ? ` · #${reason.stage + 1}` : ''}
									{typeof reason.value === 'number'
										? ` · ${numberLabel(reason.value, locale, 5)}`
										: ''}
									{reason.limit !== undefined ? ` / ${numberLabel(reason.limit, locale, 5)}` : ''}
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			</div>
			{#if accepted}
				<div class="stat-row">
					<div class="stat">
						<small>{t.preamp}</small><output
							>{numberLabel(accepted.curve.preampDb, locale, 1)} dB</output
						>
					</div>
					<div class="stat">
						<small>{t.level}</small><output
							>{numberLabel(levelDb(accepted.curve.bands, accepted.curve.preampDb), locale, 1)} dB</output
						>
					</div>
					<div class="stat">
						<small>{t.fit}</small><output>{numberLabel(accepted.rmsDb, locale, 2)}</output>
					</div>
					<div class="stat"><small>CRC</small><output>0x{crc}</output></div>
				</div>
				<div class="table-scroll">
					<table class="sect-table">
						<caption>{t.sections}</caption>
						<thead>
							<tr><th>#</th><th>{t.kind}</th><th>{t.frequency}</th><th>{t.gain}</th><th>Q</th></tr>
						</thead>
						<tbody>
							{#each accepted.curve.bands as band, index (index)}
								<tr>
									<td>{index + 1}</td><td>{band.kind}</td>
									<td
										>{band.kind === 'OFF' ? '·' : `${numberLabel(band.freqHz ?? 0, locale)} Hz`}</td
									>
									<td
										>{band.kind === 'OFF'
											? '·'
											: `${numberLabel(band.gainDb ?? 0, locale, 1)} dB`}</td
									>
									<td>{band.kind === 'OFF' ? '·' : numberLabel(band.qFactor ?? 0, locale, 2)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
			<div class="actions">
				<a class="abtn" href="/" aria-disabled={!accepted || !app} onclick={open}>{t.open}</a>
				<button type="button" class="abtn" disabled={!accepted || !app} onclick={save}
					>{t.save}</button
				>
				<button
					type="button"
					class="abtn primary"
					disabled={!accepted || !app}
					onclick={() => {
						if (accepted && app)
							app.requestWrite({ ...accepted.curve, schema: 1, updatedAt: Date.now() });
					}}>{t.write}</button
				>
				<label class="field">
					{t.bounce}
					<select bind:value={bounceId}>
						{#each tracks as track (track.id)}
							<option value={track.id}>{t.track} {track.id}</option>
						{/each}
					</select>
				</label>
				<button
					type="button"
					class="abtn"
					disabled={!accepted}
					onclick={() => {
						if (accepted) onBounce(bounceId, accepted.curve);
					}}>{t.bounce}</button
				>
			</div>
			<p role="status">{status}</p>
		</div>
	</div>
</section>
