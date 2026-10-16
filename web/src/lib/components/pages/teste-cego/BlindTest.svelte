<script lang="ts">
	import { onDestroy } from 'svelte';
	import { prefersReducedMotion } from 'svelte/motion';
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import {
		IDLE_STATE,
		type AudioEngine,
		type AudioEngineState,
		type PreviewCurve
	} from '#lib/audio/engine.ts';
	import EmBreve from '#lib/components/chrome/EmBreve.svelte';
	import ListeningRoom from './ListeningRoom.svelte';
	import CandidateMeter from './CandidateMeter.svelte';
	import {
		bracketStage,
		candidate,
		estimatedWrites,
		nextSpread,
		officialCandidates,
		preferencePreview,
		recordRound,
		startSession,
		variations,
		type BracketStage,
		type Candidate,
		type OutputConfirmation,
		type Session
	} from './experiment.ts';
	import { createBlindPreview } from './preview.ts';

	let {
		audio = null,
		current = null,
		onopen,
		reducedMotion
	}: {
		audio?: AudioEngine | null;
		current?: (PreviewCurve & { name: string }) | null;
		onopen?: (value: Candidate) => boolean;
		reducedMotion?: boolean;
	} = $props();
	const uid = $props.id();
	const official = officialCandidates();
	const currentCandidate = $derived(
		current ? candidate('current', m.cego_current(), current) : null
	);
	let generated = $state.raw<Candidate[]>([]);
	const allCandidates = $derived([
		...official,
		...(currentCandidate ? [currentCandidate] : []),
		...generated
	]);
	let selected = $state<string[]>([]);
	const chosen = $derived(allCandidates.filter((c) => selected.includes(c.id)));
	let baseId = $state(official[0]?.id ?? '');
	let spread = $state(2);
	let rounds = $state(6);
	let generation = 0;
	let output = $state<OutputConfirmation | null>(null);
	let tab = $state(0);
	let audioState = $state.raw<AudioEngineState>(IDLE_STATE);
	let session = $state.raw<Session | null>(null);
	let history = $state.raw<BracketStage[]>([]);
	const last = $derived(history.at(-1) ?? null);
	let preview = $state.raw<ReturnType<typeof createBlindPreview> | null>(null);
	let active = $state(false);
	let moving = $state(false);
	let position = $state(0);
	let ratings = $state<(number | null)[]>([]);
	let heard = $state<boolean[]>([]);
	let notes = $state('');
	let labSwitch = $state(false);
	let message = $state('');
	let announcement = $state('');
	let consentData = $state(false);
	let consentWithdraw = $state(false);
	let timer: ReturnType<typeof setTimeout> | null = null;
	const reduced = $derived(reducedMotion ?? prefersReducedMotion.current);
	const labels = $derived([
		m.cego_setup(),
		m.cego_candidates(),
		m.cego_listen(),
		m.cego_results(),
		m.cego_cable(),
		m.cego_share()
	]);
	const playing = $derived(active && audioState.playing && audioState.mode === 'chains');
	const rateLabel = $derived(
		new Intl.NumberFormat(getLocale(), {
			maximumFractionDigits: 3
		}).format(audioState.rate / 1000)
	);
	const trims = $derived(audio?.matchGains(chosen.map((c) => c.level)) ?? []);
	const revealedNames = $derived(
		!active && last && session
			? (session.completed.at(-1)?.order ?? []).map(
					(id) => session?.candidates.find((c) => c.id === id)?.name ?? ''
				)
			: []
	);
	const payload = $derived(JSON.stringify(preferencePreview(!active ? session : null), null, 2));
	const chartMin = $derived(
		Math.min(0, ...(last?.results.map((r) => r.ci?.[0] ?? r.mean ?? 0) ?? []))
	);
	const chartMax = $derived(
		Math.max(10, ...(last?.results.map((r) => r.ci?.[1] ?? r.mean ?? 10) ?? []))
	);
	const chartX = (value: number) => 200 + ((value - chartMin) / (chartMax - chartMin)) * 330;

	$effect(() => {
		const engine = audio;
		audioState = engine?.state() ?? IDLE_STATE;
		return engine?.onChange((value) => {
			audioState = value;
		});
	});

	function number(value: number, digits = 1) {
		return new Intl.NumberFormat(getLocale(), {
			minimumFractionDigits: digits,
			maximumFractionDigits: digits
		})
			.format(value)
			.replace(/-/g, '−');
	}
	function clearTimer() {
		if (timer !== null) clearTimeout(timer);
		timer = null;
	}
	function releasePreview() {
		clearTimer();
		if (preview) {
			audio?.stop();
			preview.dispose();
			preview = null;
		}
		moving = false;
	}
	onDestroy(releasePreview);

	function changeTab(index: number) {
		if (active && index !== 2) return;
		tab = index;
		message = '';
	}
	function tabKey(event: KeyboardEvent, index: number) {
		let target: number;
		if (event.key === 'Home') target = 0;
		else if (event.key === 'End') target = 5;
		else if (event.key === 'ArrowRight') target = (index + 1) % 6;
		else if (event.key === 'ArrowLeft') target = (index + 5) % 6;
		else return;
		event.preventDefault();
		if (active) return;
		changeTab(target);
		document.getElementById(`${uid}-tab-${target}`)?.focus();
	}
	function toggleCandidate(id: string) {
		if (active) return;
		if (selected.includes(id)) selected = selected.filter((value) => value !== id);
		else if (selected.length < 3) selected = [...selected, id];
		else message = m.cego_candidates_required();
	}
	function generate() {
		const base = allCandidates.find((c) => c.id === baseId);
		if (!base) return;
		generated = variations(base, spread, ++generation);
		selected = selected.filter((id) => !id.startsWith('variation:'));
	}
	function transition(done: () => void, always = true) {
		clearTimer();
		preview?.mute();
		if (reduced || !always) {
			moving = false;
			done();
			announcement = [
				reduced ? m.cego_instant() : m.cego_ready(),
				session
					? m.cego_round({ number: session.completed.length + 1, total: session.planned })
					: '',
				m.cego_position({ number: position + 1 })
			].join(' ');
		} else {
			moving = true;
			announcement = m.cego_shuffling();
			timer = setTimeout(() => {
				timer = null;
				moving = false;
				done();
				announcement = m.cego_ready();
			}, 3000);
		}
	}
	function prepareRound() {
		if (!session) return;
		position = 0;
		ratings = session.order.map(() => null);
		heard = session.order.map(() => false);
		notes = '';
		transition(() => {
			if (session) preview?.select(session.order[0]!);
		});
	}
	function start(candidates = chosen, keepHistory = false) {
		message = '';
		if (!output) {
			message = m.cego_confirmation_required();
			return;
		}
		if (candidates.length < 2 || candidates.length > 3 || candidates.some((c) => !c.accepted)) {
			message = m.cego_candidates_required();
			return;
		}
		if (!audio) {
			message = m.cego_audio_error();
			return;
		}
		let next: Session;
		try {
			next = startSession(candidates, rounds, output);
		} catch {
			message = m.cego_random_error();
			return;
		}
		releasePreview();
		audio.stop();
		try {
			preview = createBlindPreview(audio, candidates);
		} catch {
			message = m.cego_audio_error();
			return;
		}
		session = next;
		if (!keepHistory) history = [];
		active = true;
		tab = 2;
		consentData = false;
		consentWithdraw = false;
		prepareRound();
	}
	async function play() {
		if (!active || moving || !audio || !session || !preview) return;
		if (playing) {
			audio.stop();
			return;
		}
		const playingSession = session;
		const playingPreview = preview;
		const engine = audio;
		const index = position;
		try {
			preview.select(session.order[position]!);
			await engine.start('chains');
			if (!active || session !== playingSession || preview !== playingPreview) {
				engine.stop();
				return;
			}
			if (engine.state().mode === 'chains') heard[index] = true;
			message = '';
		} catch {
			message = m.cego_audio_error();
		}
	}
	function selectPosition(index: number) {
		if (!active || moving || !session || index >= session.order.length) return;
		transition(
			() => {
				position = index;
				if (session) preview?.select(session.order[index]!);
				if (playing) heard[index] = true;
			},
			labSwitch && position !== index
		);
	}
	function setRating(index: number, raw: string) {
		const value = raw === '' ? null : Number(raw);
		ratings[index] =
			value !== null && Number.isFinite(value) && value >= 0 && value <= 10 ? value : null;
	}
	function finishRound(reveal = false) {
		if (!session || moving) return;
		if (ratings.some((v) => v === null) || heard.some((value) => !value)) {
			message = m.cego_ratings_required();
			return;
		}
		try {
			session = recordRound(session, ratings);
		} catch {
			message = m.cego_random_error();
			return;
		}
		audio?.stop();
		message = '';
		if (reveal || session.completed.length === session.planned) {
			const stage = bracketStage(session, spread);
			history = [...history, stage];
			active = false;
			releasePreview();
			tab = 3;
			announcement = m.cego_revealed();
		} else prepareRound();
	}
	function reset() {
		releasePreview();
		active = false;
		session = null;
		history = [];
		tab = 1;
		message = '';
		announcement = m.cego_closed();
		consentData = false;
		consentWithdraw = false;
	}
	function continueTournament() {
		if (!last) return;
		const next = nextSpread(last);
		if (next === null) return;
		const neighbors = variations(last.winner, next, ++generation).slice(0, 2);
		if (neighbors.some((c) => !c.accepted)) {
			message = m.cego_candidates_required();
			return;
		}
		spread = next;
		start([last.winner, ...neighbors], true);
	}
	function openWinner(event: MouseEvent) {
		if (!last || !onopen?.(last.winner)) event.preventDefault();
	}
	function keyboard(event: KeyboardEvent) {
		if (
			!active ||
			event.altKey ||
			event.ctrlKey ||
			event.metaKey ||
			(event.target instanceof HTMLElement &&
				event.target.closest('input,textarea,select,button,a,[contenteditable]'))
		)
			return;
		if (['1', '2', '3'].includes(event.key)) {
			event.preventDefault();
			selectPosition(Number(event.key) - 1);
		}
		if (event.code === 'Space') {
			event.preventDefault();
			void play();
		}
	}
</script>

<svelte:head><title>{m.cego_title()} · open-auri</title></svelte:head>
<svelte:window onkeydown={keyboard} />

<div class="blind-test">
	<ListeningRoom
		revealed={!active && last !== null}
		{moving}
		selected={active ? position : -1}
		names={revealedNames}
		count={session?.candidates.length ?? 3}
		disabled={!active}
		onselect={selectPosition}
	/>
	<div class="sr" role="status" aria-live="polite">{announcement}</div>
	<section class="desk" aria-label={m.cego_console()}>
		<div class="desk-grid">
			<aside class="rack" aria-label={m.cego_console()}>
				<p class="engrave">{m.cego_console()}</p>
				<div class="seg-row">
					<div class="seg">
						{session
							? m.cego_round({
									number: Math.min(session.completed.length + (active ? 1 : 0), session.planned),
									total: session.planned
								})
							: m.cego_rounds()}
					</div>
				</div>
				<div class="seg rate">{m.cego_rate({ rate: rateLabel })}</div>
				<div class="keys">
					{#each [0, 1, 2] as index (index)}
						<button
							class="key"
							type="button"
							aria-label={m.cego_position({ number: index + 1 })}
							aria-pressed={active && position === index}
							disabled={!active || moving || index >= (session?.order.length ?? 0)}
							onclick={() => selectPosition(index)}>{index + 1}</button
						>
					{/each}
				</div>
				<button
					class="transport"
					type="button"
					aria-pressed={playing}
					disabled={!active || moving}
					onclick={play}>{playing ? 'Ⅱ' : '▶'} {playing ? m.cego_pause() : m.cego_play()}</button
				>
				<label class="switch"
					><input type="checkbox" bind:checked={labSwitch} /><span
						>{m.cego_switch()}<small>{m.cego_switch_note()}</small></span
					></label
				>
				<p class="matched">
					<span class="lamp" class:on={preview !== null}></span>{m.cego_matched()}
				</p>
				<p class="note">{m.cego_shortcuts()}</p>
			</aside>
			<div class="tablet">
				<div class="screen">
					<div class="steps" role="tablist" aria-label={m.cego_steps()}>
						{#each labels as label, index (index)}
							<button
								type="button"
								role="tab"
								id="{uid}-tab-{index}"
								aria-controls="{uid}-panel-{index}"
								aria-selected={tab === index}
								tabindex={tab === index ? 0 : -1}
								disabled={active && index !== 2}
								onkeydown={(event) => tabKey(event, index)}
								onclick={() => changeTab(index)}><span>0{index + 1}</span>{label}</button
							>
						{/each}
					</div>
					{#each labels.keys() as panelIndex (panelIndex)}
						<div
							class="panel"
							role="tabpanel"
							id="{uid}-panel-{panelIndex}"
							aria-labelledby="{uid}-tab-{panelIndex}"
							tabindex="0"
							hidden={tab !== panelIndex}
						>
							{#if tab === panelIndex}
								{#if tab === 0}
									<h2>{m.cego_setup()}</h2>
									<p class="lede">{m.cego_setup_lede()}</p>
									<div class="grid2">
										<div class="card">
											<h3>{m.cego_source()}</h3>
											<strong>{audioState.file?.name ?? m.cego_noise()}</strong>
											<p class="note">{m.cego_source_note()}</p>
										</div>
										<fieldset class="card">
											<legend>{m.cego_output()}</legend>
											<label class="opt"
												><input
													type="radio"
													name="{uid}-output"
													value="neutral"
													bind:group={output}
												/><span
													><b>{m.cego_neutral()}</b><small>{m.cego_neutral_note()}</small></span
												></label
											>
											<label class="opt"
												><input
													type="radio"
													name="{uid}-output"
													value="other"
													bind:group={output}
												/><span><b>{m.cego_other()}</b><small>{m.cego_other_note()}</small></span
												></label
											>
										</fieldset>
									</div>
									<div class="card">
										<h3>{m.cego_matched()}</h3>
										<p class="note">{m.cego_level_note()}</p>
										<p class="note">{m.cego_engine_note()}</p>
										{#each chosen as c, index (c.id)}<p class="level">
												{c.name}: {number(c.level)} dB · {number(trims[index] ?? 0)} dB
											</p>{/each}
									</div>
									<div class="actions">
										<button class="accent" type="button" onclick={() => changeTab(1)}
											>{m.cego_pick()}</button
										>
									</div>
								{:else if tab === 1}
									<h2>{m.cego_candidates()}</h2>
									<p class="lede">{m.cego_candidates_lede()}</p>
									<h3>{m.cego_official()} · {m.cego_current()}</h3>
									<div class="candidates">
										{#each allCandidates as c (c.id)}
											<label
												class="candidate"
												class:checked={selected.includes(c.id)}
												class:rejected={!c.accepted}
											>
												<span class="candidate-top"
													><input
														type="checkbox"
														checked={selected.includes(c.id)}
														disabled={!c.accepted ||
															(!selected.includes(c.id) && selected.length >= 3)}
														onchange={() => toggleCandidate(c.id)}
													/><strong>{c.name}</strong></span
												>
												{#if c.description}<span class="description" lang="pt-BR"
														>{c.description}</span
													><small>{m.cego_attribution()}</small>{/if}
												{#if c.experimental}<small class="warn">{m.cego_experimental()}</small>{/if}
												<small class="mono"
													>preamp {number(c.preampDb)} dB · level {c.accepted
														? number(c.level)
														: '−'} dB</small
												>
												{#if !c.accepted}<small class="warn"
														>{m.cego_rejected({ reasons: c.reasons.join(', ') })}</small
													>{/if}
											</label>
										{/each}
									</div>
									<p class="note">{m.cego_gate_note()}</p>
									<div class="grid2">
										<div class="card">
											<h3>{m.cego_variations()}</h3>
											<label for="{uid}-base">{m.cego_base()}</label><select
												id="{uid}-base"
												bind:value={baseId}
												>{#each allCandidates.filter((c) => !c.id.startsWith('variation:') && c.accepted) as c (c.id)}<option
														value={c.id}>{c.name}</option
													>{/each}</select
											>
											<label for="{uid}-spread">{m.cego_spread()}: {number(spread)}</label><input
												id="{uid}-spread"
												type="range"
												min="0.5"
												max="4"
												step="0.5"
												bind:value={spread}
											/>
											<button type="button" onclick={generate}>{m.cego_generate()}</button>
											<p class="note">{m.cego_variation_note()}</p>
										</div>
										<div class="card">
											<h3>{m.cego_rounds()}</h3>
											<label for="{uid}-rounds">{m.cego_rounds()}: {rounds}</label><input
												id="{uid}-rounds"
												type="range"
												min="2"
												max="12"
												step="1"
												bind:value={rounds}
											/>
											<p>{m.cego_selection({ count: selected.length })}</p>
											<button class="accent" type="button" onclick={() => start()}
												>{m.cego_start()}</button
											>
										</div>
									</div>
								{:else if tab === 2}
									{#if active && session}
										<h2>
											{m.cego_round({
												number: session.completed.length + 1,
												total: session.planned
											})}
										</h2>
										<p class="lede">{m.cego_listen_lede()}</p>
										<button type="button" disabled={moving} onclick={play}
											>{playing ? m.cego_pause() : m.cego_play()}</button
										>
										<div class="bignums">
											{#each session.order as id, index (id)}
												<div>
													<button
														type="button"
														class="bignum"
														aria-pressed={position === index}
														disabled={moving}
														onclick={() => selectPosition(index)}
														><span>{index + 1}</span>{m.cego_position({
															number: index + 1
														})}</button
													>
													<CandidateMeter
														chain={preview?.chains[
															session.candidates.findIndex((c) => c.id === id)
														] ?? null}
														enabled={playing && position === index && !moving}
														label={m.cego_position({ number: index + 1 })}
													/>
												</div>
											{/each}
										</div>
										<div class="card">
											<h3>{m.cego_rating_note()}</h3>
											{#each session.order as id, index (id)}
												<div class="rating">
													<label for="{uid}-rating-{index}"
														>{m.cego_rating({ number: index + 1 })}</label
													>
													<input
														type="range"
														min="0"
														max="10"
														step="0.5"
														value={ratings[index] ?? 5}
														disabled={moving || !heard[index]}
														aria-label={m.cego_rating({ number: index + 1 })}
														aria-valuetext={ratings[index] === null
															? m.cego_unrated()
															: number(ratings[index]!)}
														oninput={(event) => setRating(index, event.currentTarget.value)}
													/>
													<input
														id="{uid}-rating-{index}"
														type="number"
														min="0"
														max="10"
														step="0.5"
														placeholder={m.cego_unrated()}
														value={ratings[index] ?? ''}
														disabled={moving || !heard[index]}
														oninput={(event) => setRating(index, event.currentTarget.value)}
													/>
												</div>
											{/each}
											<label for="{uid}-notes">{m.cego_notes()}</label><textarea
												id="{uid}-notes"
												bind:value={notes}></textarea>
										</div>
										<div class="actions">
											<button
												class="accent"
												type="button"
												disabled={moving}
												onclick={() => finishRound()}>{m.cego_next()}</button
											><button type="button" disabled={moving} onclick={() => finishRound(true)}
												>{m.cego_finish()}</button
											><button type="button" onclick={reset}>{m.cego_cancel()}</button>
										</div>
									{:else}<h2>{m.cego_listen()}</h2>
										<p class="empty">{m.cego_empty_listen()}</p>{/if}
								{:else if tab === 3}
									<h2>{m.cego_revealed()}</h2>
									{#if last}
										<p class="lede">
											{last.tied ? m.cego_tied() : m.cego_winner({ name: last.winner.name })}
										</p>
										<div class="card">
											<h3>{m.cego_mean()} · {m.cego_ci()}</h3>
											<svg
												class="chart"
												viewBox="0 0 560 230"
												role="img"
												aria-label={m.cego_chart()}
											>
												{#each last.results as result, index (result.candidate.id)}
													<text x="5" y={35 + index * 65} fill="#ece7dd"
														>{result.candidate.name}</text
													>
													<line
														x1="200"
														x2="530"
														y1={30 + index * 65}
														y2={30 + index * 65}
														stroke="#514735"
													/>
													{#if result.ci}<line
															x1={chartX(result.ci[0])}
															x2={chartX(result.ci[1])}
															y1={30 + index * 65}
															y2={30 + index * 65}
															stroke="#ffd27a"
															stroke-width="3"
														/>{/if}
													<circle
														cx={chartX(result.mean ?? 0)}
														cy={30 + index * 65}
														r="6"
														fill="#ffd27a"
													/>
												{/each}
												<text x="200" y="225" fill="#bdb5a6">{number(chartMin)}</text><text
													x="500"
													y="225"
													fill="#bdb5a6">{number(chartMax)}</text
												>
											</svg>
											<div class="table-wrap">
												<table>
													<thead
														><tr
															><th>{m.cego_candidates()}</th><th>{m.cego_mean()}</th><th
																>{m.cego_ci()}</th
															><th>{m.cego_sample()}</th></tr
														></thead
													><tbody>
														{#each last.results as result (result.candidate.id)}<tr
																><th scope="row">{result.candidate.name}</th><td
																	>{number(result.mean ?? 0, 2)}</td
																><td
																	>{result.ci
																		? `${number(result.ci[0], 2)} … ${number(result.ci[1], 2)}`
																		: m.cego_no_ci()}</td
																><td>{result.n}</td></tr
															>{/each}
													</tbody>
												</table>
											</div>
											<p class="note">{m.cego_ci_note()}</p>
											<a
												href="https://www.itl.nist.gov/div898/handbook/eda/section3/eda3672.htm"
												target="_blank"
												rel="noreferrer">{m.cego_ci_source()}</a
											>
										</div>
										<div class="card">
											<h3>{m.cego_bracket()}</h3>
											<ol class="bracket">
												{#each history as stage, index (stage)}<li>
														<strong
															>{m.cego_stage({
																number: index + 1,
																spread: number(stage.spread)
															})}</strong
														>
														<ul>
															{#each stage.results as result (result.candidate.id)}<li>
																	{result.candidate.name} · {number(result.mean ?? 0, 2)}
																</li>{/each}
														</ul>
														<p>
															{stage.tied
																? m.cego_tied()
																: m.cego_winner({ name: stage.winner.name })}
														</p>
													</li>{/each}
											</ol>
											<p class="note">{m.cego_bracket_note()}</p>
										</div>
										<div class="actions">
											<a class="button accent" href="/" onclick={openWinner}>{m.cego_open()}</a
											><button
												type="button"
												disabled={nextSpread(last) === null}
												onclick={continueTournament}>{m.cego_continue()}</button
											><button type="button" onclick={reset}>{m.cego_new()}</button>
										</div>
									{:else}<p class="empty">{m.cego_empty_results()}</p>{/if}
								{:else if tab === 4}
									<h2>{m.cego_cable_title()}</h2>
									<p class="lede">{m.cego_cable_note()}</p>
									<EmBreve title={m.cego_cable_title()} />
									<div class="card">
										<p class="cost">
											{m.cego_writes({
												count: estimatedWrites(
													session?.planned ?? rounds,
													session?.candidates.length ?? Math.max(2, chosen.length)
												)
											})}
										</p>
										<p class="note">{m.cego_cost_note()}</p>
									</div>
								{:else}
									<h2>{m.cego_share_title()}</h2>
									<p class="lede">{m.cego_share_note()}</p>
									<div class="card">
										<label class="opt"
											><input type="checkbox" bind:checked={consentData} /><span
												>{m.cego_consent_data()}</span
											></label
										><label class="opt"
											><input type="checkbox" bind:checked={consentWithdraw} /><span
												>{m.cego_consent_withdraw()}</span
											></label
										>
										<p class="note">{m.cego_private()}</p>
										<button class="accent" type="button" disabled aria-describedby="{uid}-send-note"
											>{m.cego_send()}</button
										>
										<p id="{uid}-send-note" class="note">{m.cego_send_later()}</p>
									</div>
									<h3>{m.cego_preview()}</h3>
									<textarea
										class="payload"
										readonly
										rows="12"
										wrap="off"
										aria-label={m.cego_preview()}
										value={payload}></textarea>
								{/if}
								{#if !audioState.exact}<p class="warn">{m.cego_approximate()}</p>{/if}
								<p class="message" role="status">{message}</p>
							{/if}
						</div>
					{/each}
				</div>
			</div>
		</div>
	</section>
</div>

<style>
	.blind-test {
		--accent: #ffd27a;
		--muted: #b5ad9f;
		--rule: #ece7dd24;
		color: #ece7dd;
		font: 15px/1.5 var(--sans, 'Geist', system-ui, sans-serif);
	}
	.blind-test :global(*) {
		box-sizing: border-box;
	}
	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
	}
	.desk {
		position: relative;
		padding: 34px clamp(12px, 3vw, 40px) 46px;
		background:
			repeating-linear-gradient(2deg, #0000 0 3px, #e9b67a08 4px, #0000 6px 10px),
			linear-gradient(115deg, #6a472d44, #0000 38%), linear-gradient(#4a301b, #2f1e11);
		box-shadow: inset 0 14px 22px -10px #000d;
		border-top: 4px solid #6a4628;
	}
	.desk-grid {
		display: grid;
		grid-template-columns: 300px minmax(0, 1fr);
		gap: 28px;
		max-width: 1360px;
		margin: auto;
		align-items: start;
	}
	.rack {
		padding: 22px 20px 18px;
		border-radius: 12px;
		background:
			repeating-linear-gradient(90deg, #ffffff05 0 1px, #0000 1px 3px),
			linear-gradient(170deg, #3a3631, #24211d 40%, #171512);
		box-shadow:
			inset 0 1px #ffffff22,
			0 22px 34px -14px #000d,
			0 3px 6px #0008;
	}
	.engrave {
		font: 10px var(--mono, monospace);
		letter-spacing: 0.2em;
		color: #b5ad9f;
		text-transform: uppercase;
		margin: 0 0 8px;
	}
	.seg {
		flex: 1;
		background: #0b0907;
		border-radius: 6px;
		padding: 10px;
		font: 17px var(--mono, monospace);
		color: var(--accent);
		box-shadow: inset 0 2px 6px #000e;
		margin-bottom: 16px;
	}
	.rate {
		font-size: 12px;
	}
	.keys {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 12px;
		margin-bottom: 20px;
	}
	button,
	.button {
		font: inherit;
		border: 1px solid var(--rule);
		border-radius: 6px;
		background: transparent;
		color: inherit;
		padding: 7px 12px;
		cursor: pointer;
		text-decoration: none;
	}
	button:hover,
	.button:hover {
		border-color: #b5ad9f;
	}
	button:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	:global(.blind-test :focus-visible) {
		outline: 2px solid #ffd27a;
		outline-offset: 3px;
	}
	button.key {
		aspect-ratio: 1;
		border: 0;
		font: 30px var(--mono, monospace);
		background: linear-gradient(#34302b, #1d1a17);
		box-shadow:
			inset 0 1px #ffffff22,
			0 5px #0b0a09,
			0 10px 16px #0009;
	}
	.key[aria-pressed='true'] {
		color: var(--accent);
		transform: translateY(3px);
		box-shadow:
			0 2px #0b0a09,
			0 0 22px -4px #ffd27a77;
	}
	.transport {
		background: #14110e;
		min-height: 44px;
	}
	.switch {
		display: flex;
		gap: 10px;
		align-items: center;
		margin: 18px 0;
		font-size: 12px;
	}
	small {
		display: block;
		font-size: 11px;
		color: var(--muted);
	}
	.matched {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 13px;
	}
	.lamp {
		display: inline-block;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: #17130e;
	}
	.lamp.on {
		background: var(--accent);
		box-shadow: 0 0 10px #ffd27a55;
	}
	.tablet {
		border-radius: 28px;
		padding: 14px;
		background: linear-gradient(160deg, #1a1a1b, #0a0a0b 50%);
		box-shadow:
			0 38px 60px -26px #000e,
			inset 0 1px #ffffff24;
		min-width: 0;
	}
	.screen {
		border-radius: 16px;
		overflow: hidden;
		background: radial-gradient(120% 80% at 20% 0%, #1a1916, #121110 60%);
		min-height: 520px;
	}
	.steps {
		display: grid;
		grid-template-columns: repeat(6, minmax(0, 1fr));
		border-bottom: 1px solid var(--rule);
		background: #0004;
	}
	.steps button {
		text-align: left;
		border: 0;
		border-bottom: 2px solid transparent;
		border-radius: 0;
		padding: 12px 10px;
		font-size: 12px;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.steps span {
		display: block;
		font: 10px var(--mono, monospace);
		letter-spacing: 0.14em;
		margin-bottom: 3px;
	}
	.steps [aria-selected='true'] {
		border-bottom-color: var(--accent);
		color: #ece7dd;
	}
	.steps [aria-selected='true'] span {
		color: var(--accent);
	}
	.panel {
		padding: 22px 24px 26px;
	}
	.panel[hidden] {
		display: none;
	}
	h2 {
		font: 400 30px/1.1 var(--serif, 'Instrument Serif', Georgia, serif);
		margin: 0 0 8px;
	}
	h3,
	legend {
		font-size: 13px;
		font-weight: 600;
		margin: 0 0 10px;
	}
	.lede {
		color: #c4bbaa;
		margin: 0 0 18px;
	}
	.grid2 {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 14px;
		margin-top: 18px;
	}
	.card {
		border: 1px solid var(--rule);
		border-radius: 12px;
		padding: 16px;
		background: #ffffff04;
		margin: 0 0 14px;
		min-width: 0;
	}
	.opt {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		padding: 10px 0;
		cursor: pointer;
		font-size: 13px;
	}
	.opt input {
		flex: 0 0 auto;
		margin-top: 4px;
	}
	.opt small {
		margin-top: 4px;
	}
	.note {
		font-size: 12px;
		color: var(--muted);
		margin: 10px 0 0;
	}
	.warn,
	.message {
		color: #e8d3a6;
		font-size: 13px;
	}
	.message {
		min-height: 1.5em;
		margin: 12px 0 0;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		margin-top: 18px;
	}
	.accent {
		background: var(--accent);
		color: #1d1606;
		border-color: var(--accent);
		font-weight: 600;
	}
	.level,
	.mono {
		font-family: var(--mono, monospace);
		font-size: 11px;
	}
	.candidates {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 10px;
	}
	.candidate {
		border: 1px solid var(--rule);
		border-radius: 10px;
		padding: 12px;
		cursor: pointer;
		background: #ffffff03;
		min-width: 0;
	}
	.candidate.checked {
		border-color: var(--accent);
		background: #ffd27a0f;
	}
	.candidate.rejected {
		opacity: 0.7;
	}
	.candidate-top {
		display: flex;
		gap: 8px;
		align-items: center;
		font-size: 14px;
	}
	.description {
		display: block;
		font-size: 12px;
		color: #c5bcab;
		margin: 6px 0 4px;
	}
	.candidate small {
		margin-top: 5px;
	}
	input {
		accent-color: var(--accent);
	}
	input[type='range'] {
		width: 100%;
		min-height: 30px;
	}
	select,
	textarea,
	input[type='number'] {
		font: inherit;
		color: #ece7dd;
		background: #0c0b09;
		border: 1px solid var(--rule);
		border-radius: 8px;
		padding: 8px;
		width: 100%;
	}
	select {
		margin: 5px 0 12px;
	}
	textarea {
		min-height: 72px;
		margin-top: 8px;
		resize: vertical;
	}
	label {
		font-size: 13px;
	}
	.rating {
		display: grid;
		grid-template-columns: 1fr minmax(80px, 1fr) 75px;
		align-items: center;
		gap: 12px;
		margin: 12px 0;
	}
	.rating input[type='number'] {
		font: 12px var(--mono, monospace);
	}
	.bignums {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 12px;
		margin: 18px 0;
	}
	.bignum {
		width: 100%;
		border-radius: 14px;
		background: linear-gradient(#1f1d1a, #141311);
		font: 10px var(--mono, monospace);
		padding: 16px 8px;
	}
	.bignum span {
		display: block;
		font: 64px/1 var(--serif, 'Instrument Serif', Georgia, serif);
	}
	.bignum[aria-pressed='true'] {
		border-color: var(--accent);
		color: var(--accent);
		background: #292214;
	}
	.empty {
		padding: 26px;
		border: 1px dashed var(--rule);
		border-radius: 12px;
		color: var(--muted);
	}
	.chart {
		width: 100%;
		height: auto;
		font: 12px var(--mono, monospace);
	}
	.table-wrap {
		overflow-x: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 12px;
		text-align: left;
	}
	th,
	td {
		padding: 8px 4px;
		border-bottom: 1px solid var(--rule);
	}
	td {
		font-family: var(--mono, monospace);
	}
	a {
		color: #d9c79f;
		font-size: 12px;
	}
	.bracket {
		list-style: none;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 16px;
	}
	.bracket > li {
		border-left: 2px solid var(--accent);
		padding: 12px;
		background: #ffd27a09;
		flex: 1 1 180px;
		font-size: 12px;
	}
	.bracket ul {
		padding-left: 16px;
	}
	.cost {
		font: 36px var(--serif, 'Instrument Serif', Georgia, serif);
		color: var(--accent);
	}
	.payload {
		max-height: 300px;
		overflow: auto;
		font: 11px/1.5 var(--mono, monospace);
		background: #0b0a09;
		border: 1px solid var(--rule);
		border-radius: 10px;
		padding: 12px;
	}
	@media (max-width: 980px) {
		.desk-grid {
			grid-template-columns: 1fr;
		}
		.rack {
			max-width: none;
		}
		.keys {
			max-width: 300px;
		}
	}
	@media (max-width: 760px) {
		.steps {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
		.grid2 {
			grid-template-columns: 1fr;
		}
		.panel {
			padding: 18px 14px;
		}
		.tablet {
			padding: 9px;
			border-radius: 20px;
		}
		.rating {
			grid-template-columns: 1fr 75px;
			gap: 6px;
		}
		.rating label {
			grid-column: 1/-1;
		}
		.bignums {
			gap: 6px;
		}
		.bignum {
			padding: 10px 3px;
			font-size: 9px;
		}
		.bignum span {
			font-size: 48px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.key[aria-pressed='true'] {
			transform: none;
		}
	}
</style>
