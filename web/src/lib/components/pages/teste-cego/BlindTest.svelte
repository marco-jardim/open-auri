<script module lang="ts">
	import { LazyModule } from '#lib/app/lazy.svelte.ts';

	// FUX.B: the social tabs (Comunidade candidates, S6 batch with its consent-gated Turnstile) are
	// their own chunks, prefetched on idle and shown when their tab opens.
	const communityCandidates = new LazyModule(() => import('./CommunityCandidates.svelte'));
	const s6Send = new LazyModule(() => import('./S6Send.svelte'));
</script>

<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { prefersReducedMotion } from 'svelte/motion';
	import { whenIdle } from '#lib/app/runtime.ts';
	import { getAppContext, type AppContext } from '#lib/app/context.svelte.ts';
	import Deferred from '#lib/components/pages/lazy/Deferred.svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import {
		IDLE_STATE,
		type AudioEngine,
		type AudioEngineState,
		type PreviewCurve
	} from '#lib/audio/engine.ts';
	import { tap, type MeterSource } from '#lib/audio/meters.ts';
	import { warmAudio } from '#lib/audio/warm.ts';
	import TesteCegoArt from '#lib/components/art/TesteCegoArt.svelte';
	import EmBreve from '#lib/components/chrome/EmBreve.svelte';
	import Button from '#lib/components/primitives/Button.svelte';
	import Lamp from '#lib/components/primitives/Lamp.svelte';
	import { Transport } from '#lib/components/audio/index.ts';
	import { Explainer } from '#lib/components/comprehension/index.ts';
	import type { SocialApi } from '#lib/social/index.ts';
	import ListeningRoom from './ListeningRoom.svelte';
	import CandidateMeter from './CandidateMeter.svelte';
	import {
		bracketStage,
		candidate,
		estimatedWrites,
		nextSpread,
		officialCandidates,
		recordRound,
		startSession,
		variations,
		type BracketStage,
		type Candidate,
		type OutputConfirmation,
		type Session
	} from './experiment.ts';
	import { createBlindPreview } from './preview.ts';
	import { autoOutput, cableConnected, lastWriteNotNeutral, type CableView } from './output.ts';

	type BlindSocialApi = Pick<
		SocialApi,
		'feed' | 'rankings' | 'getCurve' | 'postS6Batch' | 'deleteS6Batch'
	>;

	let {
		audio = null,
		current = null,
		onopen,
		reducedMotion,
		api = null,
		siteKey = '',
		cable
	}: {
		audio?: AudioEngine | null;
		current?: (PreviewCurve & { name: string }) | null;
		onopen?: (value: Candidate) => boolean;
		reducedMotion?: boolean;
		/** Social client (T4.16): Comunidade candidates and the S6 submission; null = local only. */
		api?: BlindSocialApi | null;
		/** Turnstile site key for the S6 submission. */
		siteKey?: string;
		/**
		 * Live cable state and write journal for the output choice. Omitted: the app's own cable
		 * service and journal (none when BlindTest renders without the app, e.g. in a preview).
		 */
		cable?: CableView | null;
	} = $props();
	const uid = $props.id();
	const official = officialCandidates();
	const currentCandidate = $derived(
		current ? candidate('current', m.cego_current(), current) : null
	);
	let generated = $state.raw<Candidate[]>([]);
	let community = $state.raw<Candidate[]>([]);
	const allCandidates = $derived([
		...official,
		...(currentCandidate ? [currentCandidate] : []),
		...community,
		...generated
	]);
	let selected = $state<string[]>([]);
	const chosen = $derived(allCandidates.filter((c) => selected.includes(c.id)));
	let baseId = $state(official[0]?.id ?? '');
	let spread = $state(2);
	let rounds = $state(6);
	let generation = 0;
	/** No app provider (BlindTest rendered on its own): then there is no cable to read. */
	function optionalAppContext(): AppContext | null {
		try {
			return getAppContext();
		} catch {
			return null;
		}
	}
	const appContext = optionalAppContext();
	/** No last-real accessor: scan once per journal change, never once per cable-state update. */
	const appLastRealWrite = $derived.by(() => {
		if (cable !== undefined) return null;
		const entries = appContext?.client?.state.journal.entries ?? [];
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (entry && entry.status !== 'simulated') return entry;
		}
		return null;
	});
	/** Read only: the live connection and the journal. This page never talks to the cable. */
	const cableView = $derived.by((): CableView | null => {
		if (cable !== undefined) return cable;
		const client = appContext?.client;
		return client
			? { state: client.cableState, journal: appLastRealWrite ? [appLastRealWrite] : [] }
			: null;
	});
	/** Chosen by hand in Preparo: from then on the cable state never changes the output. */
	let pickedOutput = $state<OutputConfirmation | null>(null);
	/**
	 * The declared output: a hand pick, else the live suggestion. A connected cable with a known
	 * non-Neutral write stays undeclared until picked by hand.
	 */
	const output = $derived<OutputConfirmation | null>(pickedOutput ?? autoOutput(cableView));
	/** The cable cannot be read; the journal says its last write here did not leave Neutro. */
	const outputWarning = $derived(
		(output === 'neutral' || (output === null && cableConnected(cableView))) &&
			lastWriteNotNeutral(cableView)
	);
	/** Explain the automatic choice, or the required hand pick, until the listener declares it. */
	const outputAuto = $derived(
		output === null
			? m.cego_fux_output_hint()
			: cableConnected(cableView)
				? m.cego_tcout_auto_cable()
				: m.cego_tcout_auto_none()
	);
	/**
	 * A hand pick, also of the option already preselected (a click on a checked radio fires no
	 * `change`): it only declares the output and never touches the cable.
	 */
	function pickOutput(value: OutputConfirmation) {
		pickedOutput = value;
	}
	let tab = $state(0);
	// The social tabs are not on the first tab: warm their chunks once the page is quiet.
	onMount(() =>
		whenIdle(() => {
			communityCandidates.request();
			s6Send.request();
		})
	);
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
	let fileInput: HTMLInputElement | undefined = $state();
	let loadingFile = $state(false);
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
	/** Session tag of the blind test (Transport, navbar). */
	const BLIND_SESSION = 'teste-cego';
	const playing = $derived(
		active &&
			audioState.playing &&
			audioState.mode === 'chains' &&
			audioState.session === BLIND_SESSION
	);
	/** This round is paused (Play, Transport or navbar): position, chains and trims kept. */
	const paused = $derived(active && audioState.paused && audioState.session === BLIND_SESSION);
	/**
	 * This round's session has started: a play continues it. Each round (trial) starts once, at
	 * its own random point of the file; a swap between candidates never restarts it.
	 */
	let roundStarted = false;
	/** The engine plays or holds paused the blind test's session (not raw, not another page's). */
	function owned(engine: AudioEngine): boolean {
		const state = engine.state();
		return state.session === BLIND_SESSION && (state.playing || state.paused);
	}
	const rateLabel = $derived(
		new Intl.NumberFormat(getLocale(), {
			maximumFractionDigits: 3
		}).format(audioState.rate / 1000)
	);
	const trims = $derived(audio?.matchGains(chosen.map((c) => c.level)) ?? []);
	/** The last round's order, position by position, once the result is revealed (else empty). */
	const revealedOrder = $derived(
		!active && last && session ? (session.completed.at(-1)?.order ?? []) : []
	);
	const revealedCandidates = $derived(
		revealedOrder.map((id) => session?.candidates.find((c) => c.id === id) ?? null)
	);
	const revealedNames = $derived(revealedCandidates.map((c) => c?.name ?? ''));
	const revealedScores = $derived(
		revealedOrder.map((id) => {
			const mean = last?.results.find((r) => r.candidate.id === id)?.mean ?? null;
			return mean === null ? null : number(mean, 1);
		})
	);
	const revealedTop = $derived(last && !last.tied ? revealedOrder.indexOf(last.winner.id) : -1);
	/** The scores given in the last round, position by position: read-only on stage at the result. */
	const revealedRatings = $derived(
		!active && last && session ? (session.completed.at(-1)?.ratings ?? []) : []
	);
	/** Escuta: how many positions of this round already have a score (stage faders). */
	const ratedCount = $derived(ratings.filter((value) => value !== null).length);
	/**
	 * Live level for the stage: the pre-volume meter bus (what this round plays, nothing else),
	 * tapped only while the round plays. Paused, stopped or between rounds there is no source and
	 * the stage rests in DATA.
	 */
	let stageMeter = $state.raw<MeterSource | null>(null);
	$effect(() => {
		const engine = audio;
		if (!engine || !playing) return;
		let disposed = false;
		let release = () => {};
		void tap(engine.getMeterBus(), { kinds: ['ppm'] })
			.then((meter) => {
				if (disposed) {
					meter.disconnect();
					return;
				}
				stageMeter = meter;
				release = () => meter.disconnect();
			})
			.catch((error: unknown) => {
				console.warn(JSON.stringify({ event: 'cego.stage-meter', error: (error as Error).name }));
			});
		return () => {
			disposed = true;
			stageMeter = null;
			release();
		};
	});
	const chartMin = $derived(
		Math.min(0, ...(last?.results.map((r) => r.ci?.[0] ?? r.mean ?? 0) ?? []))
	);
	const chartMax = $derived(
		Math.max(10, ...(last?.results.map((r) => r.ci?.[1] ?? r.mean ?? 10) ?? []))
	);
	const chartX = (value: number) => 200 + ((value - chartMin) / (chartMax - chartMin)) * 330;

	// Console readouts and lamps (spec §1.6): real state only, never a simulated value.
	const pad = (value: number) => String(value).padStart(2, '0');
	const roundNumber = $derived(
		session ? Math.min(session.completed.length + (active ? 1 : 0), session.planned) : 0
	);
	const roundLcd = $derived(session ? `${pad(roundNumber)}/${pad(session.planned)}` : '−−/−−');
	// The DSP rate is the AudioContext's own rate; before a context exists there is no rate yet.
	const rateLcd = $derived(audioState.ready ? `${rateLabel} kHz` : '−− kHz');
	const playReason = $derived(
		!active ? m.cego_fux_reason_play_idle() : moving ? m.cego_fux_reason_moving() : null
	);
	const movingReason = $derived(moving ? m.cego_fux_reason_moving() : null);
	const levelText = $derived(
		preview
			? m.cego_fux_level_active()
			: chosen.length >= 2
				? m.cego_fux_level_ready()
				: m.cego_fux_level_none()
	);
	const lockText = $derived(
		moving
			? m.cego_shuffling()
			: active
				? m.cego_position({ number: position + 1 })
				: m.cego_closed()
	);
	/** Spec §5.4: warm the shared engine on the press itself, before the click starts playback. */
	function warm(event: KeyboardEvent | PointerEvent) {
		if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return;
		if (playReason || !audio) return;
		warmAudio(audio).catch((error: unknown) => {
			console.warn(JSON.stringify({ event: 'cego.warm', error: (error as Error).name }));
		});
	}
	function positionReason(index: number) {
		if (!active) return m.cego_fux_reason_idle();
		if (moving) return m.cego_fux_reason_moving();
		if (index >= (session?.order.length ?? 0)) return m.cego_fux_reason_no_position();
		return null;
	}

	$effect(() => {
		const engine = audio;
		audioState = engine?.state() ?? IDLE_STATE;
		return engine?.onChange((value) => {
			audioState = value;
		});
	});
	// Audible (not shuffling) at a position means it was heard, however playback got there: the
	// Play key, or the Transport and navbar resuming the round.
	$effect(() => {
		if (playing && !moving) heard[position] = true;
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
		roundStarted = false;
		if (preview) {
			// Teardown: the blind session ends (only ours; raw or another page's audio stays).
			if (audio && owned(audio)) audio.stop();
			preview.dispose();
			preview = null;
		}
		moving = false;
	}
	onDestroy(releasePreview);

	/** Direct source picker: the same shared engine as ♪ Áudio; the file never leaves the browser. */
	async function pickFile(event: Event & { currentTarget: HTMLInputElement }) {
		const input = event.currentTarget;
		const file = input.files?.[0];
		input.value = '';
		if (!file || !audio) return;
		loadingFile = true;
		try {
			await audio.loadFile(file);
			message = '';
		} catch (error) {
			console.warn(JSON.stringify({ event: 'cego.file', error: (error as Error).name }));
			message = m.cego_audio_error();
		} finally {
			loadingFile = false;
		}
	}
	function changeTab(index: number) {
		if (active && index !== 2) return;
		tab = index;
		message = '';
	}
	/** The stage's call to action while nothing is loaded: the candidates step, focused. */
	function pickCandidates() {
		changeTab(1);
		document.getElementById(`${uid}-tab-1`)?.focus();
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
		// A new trial: its first play starts at a new random point of the file.
		roundStarted = false;
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
		if (output === null) {
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
		prepareRound();
	}
	async function play() {
		if (!active || moving || !audio || !session || !preview) return;
		if (playing) {
			// A pause, not a stop: the round keeps its position, chains and trims.
			audio.pause();
			return;
		}
		const playingSession = session;
		const playingPreview = preview;
		const engine = audio;
		const index = position;
		try {
			preview.select(session.order[position]!);
			if (paused && roundStarted) {
				// The same trial continues where it was paused: no new random point.
				if (await engine.resume()) {
					if (engine.state().mode === 'chains') heard[index] = true;
					message = '';
					return;
				}
			}
			// Every trial starts at a random point in [25 %, 75 %] of the file; the file loops.
			await engine.start('chains', { startAt: 'random', session: BLIND_SESSION });
			if (!active || session !== playingSession || preview !== playingPreview) {
				if (owned(engine)) engine.stop();
				return;
			}
			roundStarted = true;
			if (engine.state().mode === 'chains') heard[index] = true;
			message = '';
		} catch {
			message = m.cego_audio_error();
		}
	}
	/** Transport play with nothing of this round paused: the Play key's own start. */
	async function transportPlay() {
		if (!playing) await play();
	}
	function selectPosition(index: number) {
		if (!active || moving || !session || index >= session.order.length) return;
		const always = labSwitch && position !== index;
		// A blind swap keeps the musical moment: never a restart, and the shuffle's muted seconds
		// are given back, so every candidate is compared on the same passage.
		const at = playing && always && !reduced && audio ? audio.state().position : null;
		transition(() => {
			position = index;
			if (at !== null && playing) audio?.seek(at);
			if (session) preview?.select(session.order[index]!);
			if (playing) heard[index] = true;
		}, always);
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
		// The trial is over: its session ends; the next one starts at its own random point.
		roundStarted = false;
		if (audio && owned(audio)) audio.stop();
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
	}
	function addCommunity(value: Candidate) {
		if (active || allCandidates.some((c) => c.id === value.id)) return;
		community = [...community, value];
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
	<TesteCegoArt />
	<ListeningRoom
		revealed={!active && last !== null}
		{moving}
		selected={active ? position : -1}
		names={revealedNames}
		curves={revealedCandidates}
		scores={revealedScores}
		top={revealedTop}
		tied={!active && (last?.tied ?? false)}
		count={session?.candidates.length ?? 3}
		disabled={!active}
		reducedMotion={reduced}
		meter={stageMeter}
		scoring={active}
		ratings={active ? ratings : revealedRatings}
		rateable={heard}
		onselect={selectPosition}
		onpick={pickCandidates}
		onrate={setRating}
	/>
	<div class="sr" role="status" aria-live="polite">{announcement}</div>
	<section class="desk" aria-label={m.cego_console()}>
		<div class="desk-grid">
			<aside class="rack" aria-label={m.cego_console()} data-tour="cego-listen">
				<p class="engrave">{m.cego_console()}</p>
				<div class="seg-row">
					<p class="seg">
						<small>{m.cego_fux_round_lcd()}</small><span
							class="seg-value"
							class:dim={!session}
							aria-hidden="true">{roundLcd}</span
						><span class="sr"
							>{session
								? m.cego_round({ number: roundNumber, total: session.planned })
								: m.cego_fux_round_none()}</span
						>
					</p>
					<p class="seg">
						<small>{m.cego_fux_rate_lcd()}</small><span
							class="seg-value"
							class:dim={!audioState.ready}
							aria-hidden="true">{rateLcd}</span
						><span class="sr"
							>{audioState.ready
								? m.cego_fux_rate_value({ rate: rateLabel })
								: m.cego_fux_rate_pending()}</span
						>
					</p>
				</div>
				<p class="engrave">{m.cego_fux_selector()}</p>
				<div class="keys">
					{#each [0, 1, 2] as index (index)}
						<Button
							variant="key"
							size="lg"
							class="cego-key"
							lit={active && position === index}
							aria-label={m.cego_position({ number: index + 1 })}
							aria-pressed={active && position === index}
							disabledReason={positionReason(index)}
							onclick={() => selectPosition(index)}>{index + 1}</Button
						>
					{/each}
				</div>
				<div class="rack-row">
					<Button
						variant="plate"
						size="lg"
						class="cego-play"
						aria-label={playing ? m.cego_pause() : m.cego_play()}
						aria-pressed={playing}
						disabledReason={playReason}
						onpointerdown={warm}
						onkeydown={warm}
						onclick={play}
					>
						<svg viewBox="0 0 20 20" aria-hidden="true"
							>{#if playing}<path
									d="M5 3h3.5v14H5zM11.5 3H15v14h-3.5z"
									fill="currentColor"
								/>{:else}<path d="M6 3 L17 10 L6 17 Z" fill="currentColor" />{/if}</svg
						>
					</Button>
					<button
						type="button"
						role="switch"
						class="toggle"
						aria-checked={labSwitch}
						onclick={() => (labSwitch = !labSwitch)}
					>
						<span class="track" aria-hidden="true"><span class="lever"></span></span>
						<span class="tl">{m.cego_switch()}<small>{m.cego_switch_note()}</small></span>
					</button>
				</div>
				<!-- Seek, back to start and play/pause of this round's session: time only, never which
				     candidate plays. With nothing paused, play is the Play key's own start. -->
				<div class="rack-seek">
					<Transport
						engine={audio}
						state={audio ? audioState : null}
						variant="compact"
						session={BLIND_SESSION}
						onplay={transportPlay}
						playDisabledReason={playReason}
					/>
				</div>
				<div class="lamp-row">
					<Lamp on={preview !== null} />
					<span>{m.cego_matched()}<small class="lamp-state">{levelText}</small></span>
				</div>
				<div class="lamp-row">
					<Lamp on={active && !moving} />
					<span>{m.cego_fux_lock()}<small class="lamp-state">{lockText}</small></span>
				</div>
			</aside>
			<div class="tablet">
				<div class="screen">
					<div class="steps" role="tablist" aria-label={m.cego_steps()} data-tour="cego-prepare">
						{#each labels as label, index (index)}
							<button
								type="button"
								role="tab"
								id="{uid}-tab-{index}"
								aria-controls="{uid}-panel-{index}"
								aria-selected={tab === index}
								tabindex={tab === index ? 0 : -1}
								disabled={active && index !== 2}
								aria-describedby={active && index !== 2 ? `${uid}-tabs-locked` : undefined}
								onkeydown={(event) => tabKey(event, index)}
								onclick={() => changeTab(index)}><span>0{index + 1}</span>{label}</button
							>
						{/each}
					</div>
					{#if active}<p id="{uid}-tabs-locked" class="locked">
							{m.cego_fuxb_reason_tabs_locked()}
						</p>{/if}
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
									<p class="lede">{m.cego_fux_setup_lede()}</p>
									<div class="grid3">
										<div class="card">
											<h3>
												<span class="eyebrow">{m.cego_fux_source_eyebrow()}</span
												>{m.cego_fux_source_title()}
											</h3>
											<div class="source" role="status">
												<Lamp on={audio !== null} />
												<span
													><b>{audioState.file?.name ?? m.cego_noise()}</b><small
														>{audioState.file
															? m.cego_fux_source_file()
															: m.cego_fux_source_noise()}</small
													></span
												>
											</div>
											<input
												bind:this={fileInput}
												type="file"
												accept="audio/*"
												hidden
												onchange={pickFile}
											/>
											<div class="actions tight">
												<Button
													loading={loadingFile}
													disabledReason={audio ? null : m.cego_fux_reason_no_audio()}
													onclick={() => fileInput?.click()}>{m.cego_fux_pick_file()}</Button
												>
											</div>
											<p class="note">{m.cego_fux_source_note()}</p>
										</div>
										<fieldset class="card">
											<legend
												><span class="eyebrow">{m.cego_fux_output_eyebrow()}</span
												>{m.cego_fux_output_title()}</legend
											>
											<label class="opt"
												><input
													type="radio"
													name="{uid}-output"
													value="neutral"
													checked={output === 'neutral'}
													aria-describedby={outputWarning ? `${uid}-output-warn` : undefined}
													onclick={() => pickOutput('neutral')}
													onchange={() => pickOutput('neutral')}
												/><span
													><b>{m.cego_neutral()}</b><small>{m.cego_neutral_note()}</small
													>{#if outputWarning}<small class="warn" id="{uid}-output-warn"
															>{m.cego_tcout_not_neutral()}</small
														>{/if}</span
												></label
											>
											<label class="opt"
												><input
													type="radio"
													name="{uid}-output"
													value="other"
													checked={output === 'other'}
													onclick={() => pickOutput('other')}
													onchange={() => pickOutput('other')}
												/><span><b>{m.cego_other()}</b><small>{m.cego_other_note()}</small></span
												></label
											>
											<!-- Suggest an output, or ask for a hand pick after a non-Neutral write. -->
											{#if pickedOutput === null}<p class="hint output-auto">{outputAuto}</p>{/if}
										</fieldset>
										<div class="card">
											<div class="card-head">
												<h3>
													<span class="eyebrow">{m.cego_fux_level_eyebrow()}</span
													>{m.cego_fux_level_title()}
												</h3>
												<Explainer term="ab-nivel" />
											</div>
											<p class="lamp-row">
												<Lamp on={chosen.length >= 2} /><span
													>{chosen.length >= 2
														? m.cego_fux_level_status({ count: chosen.length })
														: m.cego_fux_level_pick()}</span
												>
											</p>
											<table class="lv" aria-label={m.cego_fux_level_table()}>
												<thead
													><tr
														><th scope="col">{m.cego_fux_col_candidate()}</th><th
															scope="col"
															class="num">{m.cego_fux_col_level()}</th
														><th scope="col" class="num">{m.cego_fux_col_adjust()}</th></tr
													></thead
												>
												<tbody>
													{#each chosen as c, index (c.id)}<tr
															><th scope="row">{c.name}</th><td class="num">{number(c.level)} dB</td
															><td class="num">{number(trims[index] ?? 0)} dB</td></tr
														>{:else}<tr
															><td colspan="3" class="empty-row">{m.cego_fux_level_empty()}</td></tr
														>{/each}
												</tbody>
											</table>
											<p class="note">{m.cego_level_note()}</p>
										</div>
									</div>
									<div class="card engine">
										<div class="card-head">
											<h3>
												<span class="eyebrow">{m.cego_fux_engine_eyebrow()}</span
												>{m.cego_fux_engine_title()}
											</h3>
											<Explainer term="q27" />
										</div>
										<p class="note">{m.cego_engine_note()}</p>
									</div>
									<div class="actions">
										<Button variant="primary" onclick={() => changeTab(1)}>{m.cego_pick()}</Button>
									</div>
								{:else if tab === 1}
									<h2>{m.cego_candidates()}</h2>
									<p class="lede">{m.cego_candidates_lede()}</p>
									<h3>{m.cego_official()} · {m.cego_current()}</h3>
									<div class="candidates">
										{#each allCandidates as c, index (c.id)}
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
														aria-describedby={!c.accepted
															? `${uid}-why-${index}`
															: !selected.includes(c.id) && selected.length >= 3
																? `${uid}-limit`
																: undefined}
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
												{#if !c.accepted}<small class="warn" id="{uid}-why-{index}"
														>{m.cego_rejected({ reasons: c.reasons.join(', ') })}</small
													>{/if}
											</label>
										{/each}
									</div>
									{#if selected.length >= 3}<p class="note" id="{uid}-limit">
											{m.cego_fuxb_reason_limit()}
										</p>{/if}
									<p class="note">{m.cego_gate_note()}</p>
									<Deferred module={communityCandidates} height="6rem">
										{#snippet children(CommunityCandidates)}
											<CommunityCandidates
												{api}
												disabled={active}
												added={community.map((c) => c.id)}
												onadd={addCommunity}
											/>
										{/snippet}
									</Deferred>
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
											<Button onclick={generate}>{m.cego_generate()}</Button>
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
											<Button variant="primary" onclick={() => start()}>{m.cego_start()}</Button>
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
										<Button
											aria-pressed={playing}
											disabledReason={movingReason}
											onpointerdown={warm}
											onkeydown={warm}
											onclick={play}>{playing ? m.cego_pause() : m.cego_play()}</Button
										>
										<div class="bignums">
											{#each session.order as id, index (id)}
												<div>
													<Button
														class="bignum"
														aria-pressed={position === index}
														disabledReason={movingReason}
														onclick={() => selectPosition(index)}
														><span class="bignum-n" aria-hidden="true">{index + 1}</span
														>{m.cego_position({
															number: index + 1
														})}</Button
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
											<!-- The score faders live on the stage, under each bay: nobody has to
											     scroll away from it to rate. -->
											<p class="hint">{m.cego_tcscore_hint()}</p>
											<p class="note">
												{m.cego_tcscore_progress({
													rated: ratedCount,
													total: session.order.length
												})}
											</p>
											<label for="{uid}-notes">{m.cego_notes()}</label><textarea
												id="{uid}-notes"
												bind:value={notes}></textarea>
										</div>
										<div class="actions">
											<Button
												variant="primary"
												disabledReason={movingReason}
												onclick={() => finishRound()}>{m.cego_next()}</Button
											><Button disabledReason={movingReason} onclick={() => finishRound(true)}
												>{m.cego_finish()}</Button
											><Button variant="ghost" onclick={reset}>{m.cego_cancel()}</Button>
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
											><Button
												disabledReason={nextSpread(last) === null
													? m.cego_fux_reason_no_stage()
													: null}
												onclick={continueTournament}>{m.cego_continue()}</Button
											><Button variant="ghost" onclick={reset}>{m.cego_new()}</Button>
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
									<div class="card-head">
										<h2>{m.cego_share_title()}</h2>
										<Explainer term="s6" />
									</div>
									<p class="lede">{m.cego_share_note()}</p>
									<Deferred module={s6Send} height="10rem">
										{#snippet children(S6Send)}
											<S6Send session={!active ? session : null} {api} {siteKey} />
										{/snippet}
									</Deferred>
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
		/* FUX.ART.3: the art layer (TesteCegoArt) is positioned inside this stacking context; the
		   grid gives it the desk's own area, whatever the height of the room above. */
		position: relative;
		isolation: isolate;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		grid-template-areas: 'room' 'desk';
		color: #ece7dd;
		font: var(--fs-body) / 1.5 var(--face-body);
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
		white-space: nowrap;
	}
	.desk {
		position: relative;
		grid-area: desk;
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
		border-radius: var(--rad-2xl);
		background:
			repeating-linear-gradient(90deg, #ffffff05 0 1px, #0000 1px 3px),
			linear-gradient(170deg, #3a3631, #24211d 40%, #171512);
		box-shadow:
			inset 0 1px #ffffff22,
			0 22px 34px -14px #000d,
			0 3px 6px #0008;
	}
	.engrave {
		font: 400 var(--fs-eyebrow) var(--face-data);
		letter-spacing: 0.2em;
		color: var(--muted);
		text-transform: uppercase;
		margin: 0 0 8px;
	}
	/* LCD readouts: the label is always the smaller line (spec §1.6). */
	.seg-row {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 10px;
		margin-bottom: 16px;
	}
	.seg {
		position: relative;
		margin: 0;
		min-width: 0;
		padding: 8px 10px;
		border-radius: var(--rad-md);
		background: #0b0907;
		box-shadow: var(--well);
		color: var(--accent);
		white-space: nowrap;
	}
	.seg small {
		display: block;
		font: 400 var(--fs-eyebrow) / 1.4 var(--face-data);
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--muted);
	}
	.seg-value {
		display: block;
		font: 400 var(--fs-readout-l) / 1.2 var(--face-data);
		font-variant-numeric: tabular-nums slashed-zero;
		letter-spacing: 0.06em;
		text-shadow: 0 0 8px rgb(255 210 122 / 0.6);
		overflow: hidden;
		text-overflow: clip;
	}
	.seg-value.dim {
		color: #9a8a66;
		text-shadow: none;
	}
	.keys {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 12px;
		margin-bottom: 18px;
	}
	.keys :global(.btn.cego-key) {
		width: 100%;
		height: auto;
		aspect-ratio: 1;
		font-size: var(--fs-title);
	}
	.rack-row {
		display: flex;
		align-items: center;
		gap: 14px;
		margin-bottom: 16px;
	}
	.rack-seek {
		min-width: 0;
		margin-top: var(--space-2);
	}
	.rack-row :global(.btn.cego-play) {
		flex: 0 0 auto;
		width: 64px;
		height: 64px;
		padding: 0;
		border-radius: var(--rad-pill);
	}
	.rack-row :global(.btn.cego-play svg) {
		width: 22px;
		height: 22px;
	}
	.toggle {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: var(--hit);
		padding: 4px;
		border: 0;
		border-radius: var(--rad-md);
		background: none;
		color: var(--text);
		text-align: left;
		font: 500 var(--fs-small) / 1.25 var(--face-body);
		cursor: pointer;
	}
	.toggle:hover {
		border-color: transparent;
	}
	.track {
		position: relative;
		flex: 0 0 auto;
		width: 46px;
		height: 24px;
		border-radius: var(--rad-pill);
		background: #0d0c0a;
		box-shadow: var(--well);
	}
	.lever {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 20px;
		height: 20px;
		border-radius: 50%;
		background: radial-gradient(circle at 35% 30%, #e6dccb, #8f8577 60%, #4b453d);
		box-shadow: 0 2px 3px rgb(0 0 0 / 0.7);
		transition: left var(--dur-fast) var(--ease-mech);
	}
	.toggle[aria-checked='true'] .track {
		background: #2b220f;
	}
	.toggle[aria-checked='true'] .lever {
		left: 24px;
	}
	.tl small {
		margin-top: 2px;
		color: var(--muted);
		font-weight: 400;
	}
	.lamp-row {
		display: flex;
		align-items: center;
		gap: 10px;
		margin: 0 0 10px;
		font-size: var(--fs-small);
	}
	.lamp-state {
		font: 400 var(--fs-caption) var(--face-data);
		color: var(--muted);
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
	small {
		display: block;
		font-size: var(--label-min);
		color: var(--muted);
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
		border-radius: var(--rad-2xl);
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
		font-size: var(--fs-small);
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.steps span {
		display: block;
		font: 400 var(--fs-eyebrow) var(--face-data);
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
	.locked {
		margin: 0;
		padding: 8px 12px;
		border-bottom: 1px solid var(--rule);
		background: #0003;
		color: var(--text-2);
		font-size: var(--fs-caption);
	}
	.panel {
		padding: 22px 24px 26px;
	}
	.panel[hidden] {
		display: none;
	}
	h2 {
		font: 400 var(--fs-display-m) / 1.1 var(--face-display);
		margin: 0 0 8px;
	}
	h3,
	legend {
		font-size: var(--fs-small);
		font-weight: 600;
		margin: 0 0 10px;
	}
	.eyebrow {
		display: block;
		margin-bottom: 2px;
		font: 500 var(--fs-eyebrow) var(--face-data);
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--muted);
	}
	.card-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 8px;
	}
	.lede {
		color: #c4bbaa;
		margin: 0 0 18px;
		font-size: var(--fs-lede);
	}
	.grid2,
	.grid3 {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 14px;
		margin-top: 18px;
	}
	.grid3 {
		grid-template-columns: repeat(3, minmax(0, 1fr));
		margin-top: 0;
	}
	.card {
		border: 1px solid var(--rule);
		border-radius: var(--rad-2xl);
		padding: 16px;
		background: #ffffff04;
		margin: 0 0 14px;
		min-width: 0;
	}
	.grid3 .card {
		margin: 0;
	}
	.engine {
		margin-top: 14px;
	}
	.source {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		padding: 10px;
		border: 1px solid rgb(255 210 122 / 0.35);
		border-radius: var(--rad-lg);
		background: rgb(255 210 122 / 0.05);
		font-size: var(--fs-small);
	}
	.source :global(.lamp) {
		flex: 0 0 auto;
		margin-top: 3px;
	}
	.source small {
		margin-top: 2px;
	}
	.opt {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		padding: 10px 0;
		cursor: pointer;
		font-size: var(--fs-small);
	}
	.opt input {
		flex: 0 0 auto;
		margin-top: 4px;
	}
	.opt small {
		margin-top: 4px;
	}
	.note {
		font-size: var(--fs-caption);
		color: var(--muted);
		margin: 10px 0 0;
	}
	.hint {
		font-size: var(--fs-small);
		color: var(--text-2);
		margin: 8px 0 0;
	}
	.warn,
	.message {
		color: #e8d3a6;
		font-size: var(--fs-small);
	}
	.message {
		min-height: 1.5em;
		margin: 12px 0 0;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
		margin-top: 18px;
	}
	.actions.tight {
		margin-top: 10px;
	}
	.actions.tight :global(.btn) {
		max-width: 100%;
		white-space: normal;
	}
	.accent {
		background: var(--accent);
		color: #1d1606;
		border-color: var(--accent);
		font-weight: 600;
	}
	.mono {
		font-family: var(--face-data);
		font-size: var(--label-min);
	}
	table.lv {
		margin-top: 4px;
		font-size: var(--fs-small);
	}
	table.lv th {
		font-weight: 500;
	}
	table.lv thead th {
		color: var(--muted);
		font-size: var(--label-min);
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	.num {
		text-align: right;
		font-family: var(--face-data);
		font-variant-numeric: tabular-nums slashed-zero;
	}
	td.empty-row {
		font-family: var(--face-body);
		color: var(--muted);
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
		font-size: var(--fs-ui);
	}
	.description {
		display: block;
		font-size: var(--fs-caption);
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
	textarea {
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
		font-size: var(--fs-small);
	}
	.bignums {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 12px;
		margin: 18px 0;
	}
	.bignums :global(.btn.bignum) {
		width: 100%;
		height: auto;
		padding: 16px 8px;
		border-radius: 14px;
		font-size: var(--fs-caption);
	}
	.bignums :global(.btn.bignum .btn__label) {
		display: flex;
		flex-direction: column;
		align-items: center;
	}
	.bignum-n {
		display: block;
		font: 400 var(--fs-display-l) / 1 var(--face-display);
	}
	.bignums :global(.btn.bignum[aria-pressed='true']) {
		border-color: var(--accent);
		color: var(--accent);
		background: #292214;
	}
	.empty {
		padding: 26px;
		border: 1px dashed var(--rule);
		border-radius: var(--rad-2xl);
		color: var(--muted);
	}
	.chart {
		width: 100%;
		height: auto;
		font: var(--fs-caption) var(--face-data);
	}
	.table-wrap {
		overflow-x: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--fs-caption);
		text-align: left;
	}
	th,
	td {
		padding: 8px 4px;
		border-bottom: 1px solid var(--rule);
	}
	td {
		font-family: var(--face-data);
	}
	a {
		color: #d9c79f;
		font-size: var(--fs-caption);
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
		font-size: var(--fs-caption);
	}
	.bracket ul {
		padding-left: 16px;
	}
	.cost {
		font: var(--fs-display-m) var(--face-display);
		color: var(--accent);
	}
	@media (max-width: 1100px) {
		.grid3 {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	@media (max-width: 980px) {
		.desk-grid {
			grid-template-columns: 1fr;
		}
		.keys {
			max-width: 300px;
		}
	}
	@media (max-width: 760px) {
		.steps {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
		.grid2,
		.grid3 {
			grid-template-columns: 1fr;
		}
		.panel {
			padding: 18px 14px;
		}
		.tablet {
			padding: 9px;
			border-radius: 20px;
		}
		.bignums {
			gap: 6px;
		}
		.bignums :global(.btn.bignum) {
			padding: 10px 3px;
		}
		.bignum-n {
			font-size: var(--fs-display-m);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.lever {
			transition: none;
		}
	}
</style>
