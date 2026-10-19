<script lang="ts">
	import { onDestroy } from 'svelte';
	import { curveResponseDb, encodePayload, levelDb } from 'open-auri/dsp';
	import { numberLabel } from '#lib/charts/scales.ts';
	import { createSolverWorker } from '#lib/workers/solver-client.ts';
	import { createGateWorker } from '#lib/workers/gate-client.ts';
	import type { ClientApp } from '#lib/app/client.svelte.ts';
	import { Button } from '#lib/components/primitives/index.ts';
	import { Explainer } from '#lib/components/comprehension/index.ts';
	import { solveBlend, type BlendResult } from './blend.ts';
	import { blendTarget, type Track, type NamedCurve } from './comparison.ts';
	import ComparisonPlot from './ComparisonPlot.svelte';
	import { reasonText, type Copy } from './copy.ts';
	import type { CurveSocial } from './social.svelte.ts';
	import { classOf, exitReason } from '#lib/components/pages/curva/yolo.ts';

	let {
		tracks,
		t,
		locale,
		app,
		onBounce,
		social
	}: {
		tracks: readonly Track[];
		t: Copy;
		locale: 'pt-BR' | 'en-US';
		app: ClientApp | null;
		onBounce: (id: number, curve: NamedCurve) => void;
		social?: CurveSocial;
	} = $props();
	const uid = $props.id();
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
	/** Why a result action is unavailable: every disabled control names its reason. */
	const appReason = $derived(!accepted ? t.pending : !app ? t.reasonEngine : null);
	/**
	 * Saving to the library and publishing re-classify the exact curve stored (class-based, like
	 * every exit: curva/yolo.ts): only a rejected curve is refused. `solveBlend` gates with the
	 * standard profile, so a blend is standard; a YOLO curve would still leave marked, and its
	 * publication goes through the acknowledgement step (SocialPublish).
	 */
	const gateReason = $derived(accepted ? exitReason(accepted.curve, locale) : null);
	const saveReason = $derived(appReason ?? gateReason);
	const bounceReason = $derived(!accepted ? t.pending : null);
	// L5: the publish island is fetched only once a layer passes the gate (below the fold).
	const publishModule = $derived(
		accepted && social && gateReason === null ? import('./SocialPublish.svelte') : null
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
		const curve = accepted.curve;
		const refused = exitReason(curve, locale);
		if (refused !== null) {
			error = refused;
			return;
		}
		try {
			const saved = await app.state.library.save(curve);
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

<section class="panel" aria-labelledby="comparar-blend-title">
	<h2 class="plate" id="comparar-blend-title">{t.blend}</h2>
	<p class="note">{t.blendNote}</p>
	<div class="grid-sos">
		<div>
			<div class="headblock">
				<svg viewBox="0 0 600 160" role="img" aria-label={t.heads}>
					<title>{t.heads}</title>
					<defs>
						<linearGradient id="{uid}-head"
							><stop stop-color="#676e68" /><stop offset=".35" stop-color="#e3e7e0" /><stop
								offset="1"
								stop-color="#4c534d"
							/></linearGradient
						>
					</defs>
					<path d="M90 55 C90 5 380 5 380 55" fill="none" stroke="#f2b33d" stroke-dasharray="5 5" />
					<text x="240" y="24" text-anchor="middle" fill="#f2b33d" font-size="17">+ k × Δ</text>
					<path d="M20 115 H580" stroke="#785030" stroke-width="7" />
					{#each [70, 210, 350, 490] as x, index (x)}
						<path
							d="M{x} 55 h50 v38 q0 16 -25 16 q-25 0 -25 -16z"
							fill="url(#{uid}-head)"
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
			<Button variant="primary" size="lg" loading={busy} onclick={calculate}
				>{busy ? t.busy : t.solve}</Button
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
					{#if accepted && !busy && !error}<span class="envelope-ok">{t.envelopeOk}</span>{/if}
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
				<span class="verdict-help"><Explainer term="gate" /></span>
			</div>
			{#if accepted && social && publishModule}
				{#await publishModule then { default: SocialPublish }}
					{#key accepted}<SocialPublish {social} curve={accepted.curve} path="/comparar" />{/key}
				{/await}
			{/if}
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
			{/if}
			<!-- Always ten rows (the cable's ten sections); real values only after the gate passes. -->
			<div class="table-scroll">
				<table class={accepted ? 'sect-table' : 'sect-table-pending'}>
					<caption>{t.sections}</caption>
					<thead>
						<tr><th>#</th><th>{t.kind}</th><th>{t.frequency}</th><th>{t.gain}</th><th>Q</th></tr>
					</thead>
					<tbody>
						{#if accepted}
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
						{:else}
							{#each Array.from({ length: 10 }, (_, index) => index + 1) as row (row)}
								<tr class="pending-row"><td>{row}</td><td>·</td><td>·</td><td>·</td><td>·</td></tr>
							{/each}
						{/if}
					</tbody>
				</table>
				{#if !accepted}<p class="note">{t.tablePending}</p>{/if}
			</div>
			<p class="note" id="{uid}-reason" hidden={!appReason}>{appReason ?? ''}</p>
			<div class="actions">
				<a
					class="abtn"
					href="/"
					aria-disabled={!accepted || !app}
					aria-describedby={appReason ? `${uid}-reason` : undefined}
					onclick={open}>{t.open}</a
				>
				<Button disabledReason={saveReason} onclick={save}>{t.save}</Button>
				<Button
					variant="primary"
					disabledReason={appReason}
					onclick={() => {
						if (!accepted || !app) return;
						// `solveBlend` keeps only what the standard gate accepts, so a blend is standard
						// and opens the standard checklist. Classified at the click all the same: a YOLO
						// curve takes the YOLO checklist while Modo YOLO may write (the standard one
						// would refuse it), as every other write request does.
						const yolo =
							classOf(accepted.curve).class === 'yolo' &&
							app.yolo.enabled &&
							app.yolo.writeBlock() === null;
						app.requestWrite(
							{
								...accepted.curve,
								schema: 1,
								// A blended curve is new: it has no filter labels.
								labels: null,
								updatedAt: Date.now()
							},
							yolo ? { profile: 'yolo' } : {}
						);
					}}>{t.write}</Button
				>
				<label class="field">
					{t.bounce}
					<select bind:value={bounceId}>
						{#each tracks as track (track.id)}
							<option value={track.id}>{t.track} {track.id}</option>
						{/each}
					</select>
				</label>
				<Button
					disabledReason={bounceReason}
					onclick={() => {
						if (accepted) onBounce(bounceId, accepted.curve);
					}}>{t.bounce}</Button
				>
			</div>
			<p role="status">{status}</p>
		</div>
	</div>
</section>

<style>
	.envelope-ok {
		display: block;
		color: #f2b33d;
		font-family: var(--plate);
		font-size: var(--fs-ui, 14px);
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	.verdict-help {
		margin-left: auto;
		align-self: flex-start;
	}
	.pending-row td {
		color: #8f8a80;
	}
</style>
