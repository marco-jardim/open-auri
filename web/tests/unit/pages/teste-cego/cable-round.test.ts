/**
 * The blind test on the cable (issue #74, slice 5): `cable-round.ts` with a fake clock and a fake
 * cable port. Identical switch timing for every candidate (slow switches included), a void on
 * every failure, the audible change check, the check every four rounds, the held end and the S6
 * filter.
 */
import { describe, expect, test, vi } from 'vitest';
import { gateForWrite } from 'open-auri/safety';
import { planComparison } from '#lib/cable/compare.ts';
import type {
	CableState,
	ComparisonCancelHoldStatus,
	ComparisonEndRequest,
	ComparisonOutcome,
	ComparisonStartRequest,
	ComparisonSwitchStatus,
	LiveGestureRequest,
	LiveHoldState,
	LiveOutcome,
	LiveState
} from '#lib/cable/types.ts';
import {
	CABLE_CHECK_EVERY,
	CABLE_MUTE_FLOOR_MS,
	CABLE_MUTE_MAX_MS,
	CABLE_SWITCH_LIMIT_MS,
	CABLE_SWITCH_WINDOW_MS,
	checkCurves,
	createCableRound,
	s6Session,
	telephoneCurve,
	type CableRoundPort,
	type RoundTimer
} from '#lib/components/pages/teste-cego/cable-round.ts';
import {
	officialCandidates,
	recordRound,
	startSession,
	type Round
} from '#lib/components/pages/teste-cego/experiment.ts';
import { buildPairs } from '#lib/components/pages/teste-cego/s6.ts';

/** A manual clock: `sleep` waits until `advance` passes its time. */
function fakeTimer() {
	let now = 0;
	const waits: { at: number; resolve: () => void }[] = [];
	const flush = async () => {
		for (let i = 0; i < 20; i++) await Promise.resolve();
	};
	const timer: RoundTimer = {
		now: () => now,
		sleep: (ms) =>
			new Promise<void>((resolve) => {
				waits.push({ at: now + ms, resolve });
			})
	};
	return {
		timer,
		now: () => now,
		async advance(ms: number) {
			const target = now + ms;
			for (;;) {
				waits.sort((a, b) => a.at - b.at);
				const next = waits[0];
				if (next === undefined || next.at > target) break;
				waits.shift();
				now = next.at;
				next.resolve();
				await flush();
			}
			now = target;
			await flush();
		},
		flush
	};
}

function liveState(partial: Partial<LiveState> = {}): LiveState {
	return {
		deviceLabel: 'Cabo',
		status: 'live',
		applied: null,
		pending: false,
		ackLevelDb: null,
		hold: null,
		applies: 1,
		total: 1,
		lastError: null,
		comparison: { active: true, blind: true, count: 3, status: 'ready' },
		...partial
	};
}

function cableState(live: LiveState | null, partial: Partial<CableState> = {}): CableState {
	return {
		mode: 'real',
		connection: 'connected',
		device: null,
		deviceLabel: 'Cabo',
		devices: [],
		deviceLabels: ['Cabo'],
		writing: false,
		rescue: null,
		queue: null,
		lastOutcome: null,
		error: null,
		liveCapable: true,
		live,
		liveOrphan: null,
		...partial
	};
}

const ACCEPTED: ComparisonOutcome = {
	status: 'accepted',
	live: null,
	plan: { items: [], ackLevelDb: 0, targetLevelDb: 0, experimentalRequired: false, blind: true }
};

/** A fake cable: switches settle after `latency` ms (per index) with `status`. */
function fakeCable(clock: ReturnType<typeof fakeTimer>) {
	let state = cableState(null);
	const options = {
		latency: (index: number): number => {
			void index;
			return 300;
		},
		status: 'applied' as ComparisonSwitchStatus,
		endOutcome: { status: 'accepted', live: null } as LiveOutcome,
		hold: null as LiveHoldState | null,
		/** `confirmEndComparison`: accepted (ended reverted) or this refusal (the session goes on). */
		confirmOutcome: { status: 'accepted', live: null } as LiveOutcome,
		/** `cancelHold`'s status. */
		cancelStatus: 'cleared' as ComparisonCancelHoldStatus,
		/** `startComparison` settles only once this resolves (null: at once). */
		startGate: null as Promise<void> | null
	};
	const port = {
		getState: vi.fn(() => state),
		startComparison: vi.fn(async (request: ComparisonStartRequest): Promise<ComparisonOutcome> => {
			if (options.startGate !== null) await options.startGate;
			state = cableState(
				liveState({
					comparison: {
						active: true,
						blind: request.blind,
						count: request.curves.length,
						status: 'ready'
					}
				})
			);
			return ACCEPTED;
		}),
		switchComparison: vi.fn(async (index: number) => {
			await clock.timer.sleep(options.latency(index));
			return { status: options.status };
		}),
		cancelHold: vi.fn(() => {
			const status = options.cancelStatus;
			if (status === 'cleared' && state.live !== null) {
				state = cableState({ ...state.live, hold: null });
			}
			return { status };
		}),
		endComparison: vi.fn(async (request: ComparisonEndRequest): Promise<LiveOutcome> => {
			if (request.revert && options.endOutcome.status !== 'accepted') {
				if (state.live !== null) state = cableState({ ...state.live, hold: options.hold });
				return options.endOutcome;
			}
			end();
			return { status: 'accepted', live: null };
		}),
		confirmEndComparison: vi.fn(async (request: LiveGestureRequest): Promise<LiveOutcome> => {
			void request;
			if (state.live !== null) state = cableState({ ...state.live, hold: null });
			if (options.confirmOutcome.status !== 'accepted') return options.confirmOutcome;
			end('reverted');
			return { status: 'accepted', live: state.live };
		})
	} satisfies CableRoundPort;
	function end(reason: LiveState['endedReason'] = 'stopped') {
		const live = state.live;
		if (live === null) return;
		state = cableState({
			...live,
			status: 'ended',
			endedReason: reason,
			comparison: { ...(live.comparison ?? { blind: true, count: 2, status: 'ready' }), active: false }
		});
	}
	return {
		port,
		options,
		get state() {
			return state;
		},
		set state(next: CableState) {
			state = next;
		},
		end
	};
}

const CURVES = officialCandidates()
	.filter((c) => c.accepted)
	.slice(0, 3)
	.map((c) => ({ bands: c.bands, preampDb: c.preampDb }));

function setup(quietMs?: number) {
	const clock = fakeTimer();
	const cable = fakeCable(clock);
	const events: { at: number; kind: 'mute' | 'unmute' }[] = [];
	const output = {
		mute: () => events.push({ at: clock.now(), kind: 'mute' }),
		unmute: () => events.push({ at: clock.now(), kind: 'unmute' }),
		...(quietMs === undefined ? {} : { quietMs: () => quietMs })
	};
	const onvoid = vi.fn();
	const round = createCableRound({
		port: cable.port,
		output: () => output,
		timer: clock.timer,
		onvoid
	});
	return { clock, cable, events, round, onvoid };
}

/** Starts the set: check (both items heard, the audio playing), then "Ouvi mudar". */
async function startBlind(h: ReturnType<typeof setup>) {
	const gesture = { kind: 'cable-gesture' } as const;
	h.round.audible(true);
	expect(
		(
			await h.round.begin({
				gesture,
				confirmations: { volumeLowered: true },
				curves: CURVES,
				experimental: false
			})
		).status
	).toBe('accepted');
	const heard = h.round.playCheck(1);
	await h.clock.advance(300);
	expect(await heard).toBe('applied');
	expect((await h.round.answerCheck(true, { gesture }))?.status).toBe('accepted');
	expect(h.round.view.phase).toBe('blind');
}

/** Selects `position` (candidate `index`) and runs the clock until it settled. */
async function select(h: ReturnType<typeof setup>, position: number, index: number) {
	const result = h.round.select(position, index);
	await h.clock.advance(CABLE_SWITCH_LIMIT_MS + 500);
	return result;
}

describe('the change check curves', () => {
	test('Neutro and telefone pass the standard gate and match without refusal', () => {
		const phone = telephoneCurve();
		expect(phone.bands.some((band) => band.kind === 'HS' || band.kind === 'LP')).toBe(false);
		expect(gateForWrite(phone.bands, phone.preampDb, { experimental: false }).ok).toBe(true);
		const plan = planComparison(checkCurves(), { match: true });
		expect(plan.refusal).toBeUndefined();
		expect(plan.items).toHaveLength(2);
		expect(plan.experimentalRequired).toBe(false);
		// An obvious contrast: the two curves differ by well over a decibel somewhere.
		expect(plan.items[0]?.crc).not.toBe(plan.items[1]?.crc);
	});
});

describe('identical timing', () => {
	test('every candidate unmutes at the fixed window after the switch', async () => {
		const h = setup();
		await startBlind(h);
		const windows: number[] = [];
		for (const [position, index] of [
			[0, 2],
			[1, 0],
			[2, 1],
			[2, 1]
		] as const) {
			h.events.length = 0;
			const began = h.clock.now();
			const result = h.round.select(position, index);
			await h.clock.advance(CABLE_SWITCH_WINDOW_MS - 1);
			expect(h.events.map((event) => event.kind)).toEqual(['mute']);
			await h.clock.advance(CABLE_SWITCH_LIMIT_MS);
			expect(await result).toBe('ready');
			const unmute = h.events.find((event) => event.kind === 'unmute');
			windows.push((unmute?.at ?? NaN) - began);
			expect(h.round.view.ready).toBe(position);
		}
		expect(windows).toEqual([1200, 1200, 1200, 1200]);
		// The same position again switched too.
		expect(h.cable.port.switchComparison.mock.calls.map(([index]) => index).slice(-4)).toEqual([
			2, 0, 1, 1
		]);
	});

	test('a slow switch (below the limit) unmutes when it settled, the same for any candidate', async () => {
		const h = setup();
		await startBlind(h);
		h.cable.options.latency = () => 2000;
		const windows: number[] = [];
		for (const index of [0, 1, 2]) {
			h.events.length = 0;
			const began = h.clock.now();
			expect(await select(h, index, index)).toBe('ready');
			windows.push((h.events.find((event) => event.kind === 'unmute')?.at ?? NaN) - began);
		}
		// The quiet wait (mute ramp + output latency) comes first, the same for every candidate.
		const slow = CABLE_MUTE_FLOOR_MS + 2000;
		expect(windows).toEqual([slow, slow, slow]);
	});

	test('the switch waits until the muted output is silent (ramp + latency), the same for all', async () => {
		const h = setup(250);
		await startBlind(h);
		const starts: number[] = [];
		for (const [position, index] of [
			[0, 2],
			[1, 0],
			[2, 1]
		] as const) {
			const calls = h.cable.port.switchComparison.mock.calls.length;
			const began = h.clock.now();
			const result = h.round.select(position, index);
			await h.clock.advance(249);
			// Muted, not switched yet: the ramp and the output latency first.
			expect(h.cable.port.switchComparison).toHaveBeenCalledTimes(calls);
			await h.clock.advance(1);
			expect(h.cable.port.switchComparison).toHaveBeenCalledTimes(calls + 1);
			starts.push(h.clock.now() - began);
			await h.clock.advance(CABLE_SWITCH_LIMIT_MS);
			expect(await result).toBe('ready');
		}
		expect(starts).toEqual([250, 250, 250]);
	});

	test('without a reported latency the floor applies; a bogus one is capped', async () => {
		for (const [quiet, expected] of [
			[undefined, CABLE_MUTE_FLOOR_MS],
			[0, CABLE_MUTE_FLOOR_MS],
			[Number.NaN, CABLE_MUTE_FLOOR_MS],
			[60_000, CABLE_MUTE_MAX_MS]
		] as const) {
			const h = setup(quiet);
			await startBlind(h);
			const calls = h.cable.port.switchComparison.mock.calls.length;
			const result = h.round.select(0, 0);
			await h.clock.advance(expected - 1);
			expect(h.cable.port.switchComparison).toHaveBeenCalledTimes(calls);
			await h.clock.advance(1);
			expect(h.cable.port.switchComparison).toHaveBeenCalledTimes(calls + 1);
			await h.clock.advance(CABLE_SWITCH_LIMIT_MS + CABLE_SWITCH_WINDOW_MS);
			expect(await result).toBe('ready');
		}
	});

	test('a switch slower than the limit voids the round and stays muted', async () => {
		const h = setup();
		await startBlind(h);
		h.cable.options.latency = () => CABLE_SWITCH_LIMIT_MS + 500;
		h.events.length = 0;
		expect(await select(h, 0, 1)).toBe('void');
		expect(h.round.view).toMatchObject({ phase: 'paused', pause: 'slow', ready: null });
		expect(h.events.some((event) => event.kind === 'unmute')).toBe(false);
		expect(h.onvoid).toHaveBeenCalledWith('slow');
	});
});

describe('voids', () => {
	test.each(['unknown', 'held', 'busy', 'ended', 'error'] as const)(
		'a switch status %s voids the round',
		async (status) => {
			const h = setup();
			await startBlind(h);
			h.cable.options.status = status;
			h.events.length = 0;
			expect(await select(h, 1, 0)).toBe('void');
			expect(h.round.view).toMatchObject({ phase: 'paused', pause: status });
			expect(h.events.some((event) => event.kind === 'unmute')).toBe(false);
			expect(h.onvoid).toHaveBeenCalledWith(status);
			// Rounds stop until "Retomar".
			expect(await h.round.select(0, 0)).toBe('busy');
		}
	);

	test('an unplugged cable, another tab and "O som parou de mudar" void', async () => {
		const unplugged = setup();
		await startBlind(unplugged);
		unplugged.cable.end('disconnected');
		unplugged.round.observe(unplugged.cable.state);
		expect(unplugged.round.view.pause).toBe('disconnected');

		const elsewhere = setup();
		await startBlind(elsewhere);
		elsewhere.round.observe({
			...elsewhere.cable.state,
			liveOrphan: { crc: -1, at: 0, deviceLabel: 'Cabo' }
		});
		expect(elsewhere.round.view.pause).toBe('elsewhere');

		const stuck = setup();
		await startBlind(stuck);
		await stuck.round.voidRound('stuck');
		expect(stuck.round.view).toMatchObject({ phase: 'paused', pause: 'stuck' });
		expect(stuck.onvoid).toHaveBeenCalledWith('stuck');
	});

	test('an unplug in the middle of a switch voids it; its late result changes nothing', async () => {
		const h = setup();
		await startBlind(h);
		const result = h.round.select(0, 1);
		await h.clock.advance(100);
		h.cable.end('disconnected');
		h.round.observe(h.cable.state);
		await h.clock.advance(CABLE_SWITCH_LIMIT_MS);
		expect(await result).toBe('void');
		expect(h.round.view.phase).toBe('paused');
		expect(h.events.at(-1)?.kind).toBe('mute');
	});

	test('"Retomar" ends what runs, then the check again with a fresh gesture', async () => {
		const h = setup();
		await startBlind(h);
		await h.round.voidRound('stuck');
		const gesture = { kind: 'cable-gesture' } as const;
		expect((await h.round.resume({ gesture, confirmations: { volumeLowered: true } })).status).toBe(
			'accepted'
		);
		expect(h.cable.port.endComparison).toHaveBeenLastCalledWith({ revert: false });
		expect(h.cable.port.startComparison.mock.calls.at(-1)?.[0]).toMatchObject({
			blind: false,
			gesture
		});
		expect(h.round.view.phase).toBe('checking');
	});
});

describe('the change check', () => {
	test('a non-blind, labelled, level-matched check before the blind set', async () => {
		const h = setup();
		const gesture = { kind: 'cable-gesture' } as const;
		h.round.audible(true);
		await h.round.begin({
			gesture,
			confirmations: { volumeLowered: true },
			curves: CURVES,
			experimental: false
		});
		const check = h.cable.port.startComparison.mock.calls[0]?.[0];
		expect(check).toMatchObject({ blind: false, match: true, first: 0 });
		expect(check?.curves).toEqual(checkCurves());
		expect(h.round.view).toMatchObject({ phase: 'checking', checkPlaying: 0 });
		// Both items must be heard first.
		expect(await h.round.answerCheck(true, { gesture })).toMatchObject({ reason: 'busy' });
		const phone = h.round.playCheck(1);
		await h.clock.advance(300);
		await phone;
		expect(h.round.view.checkHeard).toEqual([true, true]);
		const answer = { kind: 'cable-gesture' } as const;
		expect((await h.round.answerCheck(true, { gesture: answer }))?.status).toBe('accepted');
		expect(h.cable.port.endComparison).toHaveBeenCalledWith({ revert: false });
		const blind = h.cable.port.startComparison.mock.calls[1]?.[0];
		expect(blind).toMatchObject({
			blind: true,
			match: true,
			gesture: answer,
			confirmations: { volumeLowered: true }
		});
		expect(blind?.curves).toEqual(CURVES);
	});

	test('"Não mudou" pauses and asks to replug', async () => {
		const h = setup();
		await h.round.begin({
			gesture: { kind: 'cable-gesture' },
			confirmations: { volumeLowered: true },
			curves: CURVES,
			experimental: false
		});
		expect(await h.round.answerCheck(false, { gesture: null })).toBeNull();
		expect(h.round.view).toMatchObject({ phase: 'paused', pause: 'no-change' });
		expect(h.cable.port.startComparison).toHaveBeenCalledTimes(1);
	});

	test(`the check is due again every ${CABLE_CHECK_EVERY} rounds; the last round is done`, async () => {
		const h = setup();
		await startBlind(h);
		for (let i = 1; i < CABLE_CHECK_EVERY; i++) {
			h.round.roundRecorded(false);
			expect(h.round.view.phase).toBe('blind');
		}
		expect(h.onvoid).not.toHaveBeenCalled();
		h.round.roundRecorded(false);
		expect(h.round.view).toMatchObject({ phase: 'paused', pause: 'check-due' });
		// The next round (not heard yet) is reshuffled; the scored rounds stay.
		expect(h.onvoid).toHaveBeenCalledTimes(1);
		expect(h.onvoid).toHaveBeenCalledWith('check-due');

		const other = setup();
		await startBlind(other);
		other.round.roundRecorded(true);
		expect(other.round.view.phase).toBe('done');
		// The blind set still runs until Salvar or Encerrar.
		expect(other.round.running()).toBe(true);
	});
});

describe('the end', () => {
	test('"Encerrar" reverts; a held revert waits for the volume confirmation', async () => {
		const h = setup();
		await startBlind(h);
		h.round.roundRecorded(true);
		h.cable.options.endOutcome = {
			status: 'refused',
			reason: 'revert-failed',
			revertFailure: 'held'
		};
		h.cable.options.hold = { reason: 'loudness', curve: 'saved' };
		const gesture = { kind: 'cable-gesture' } as const;
		await h.round.end({ gesture });
		expect(h.round.view.phase).toBe('end-held');
		h.round.cancelHeld();
		expect(h.round.view.phase).toBe('done');
		expect(h.cable.port.cancelHold).toHaveBeenCalledTimes(1);

		await h.round.end({ gesture });
		expect(h.round.view.phase).toBe('end-held');
		const ends = h.cable.port.endComparison.mock.calls.length;
		expect((await h.round.confirmHeld({ gesture })).status).toBe('accepted');
		// One service call confirms the saved curve and ends the session there (reverted).
		expect(h.cable.port.confirmEndComparison).toHaveBeenCalledWith({ gesture });
		expect(h.cable.port.endComparison).toHaveBeenCalledTimes(ends);
		expect(h.cable.state.live).toMatchObject({ status: 'ended', endedReason: 'reverted' });
		expect(h.round.view).toMatchObject({ phase: 'ended', endedReason: 'reverted' });
	});

	test('a confirmed held revert that did not land is never reported as reverted', async () => {
		const failed: LiveOutcome = {
			status: 'refused',
			reason: 'revert-failed',
			revertFailure: 'unknown'
		};
		for (const done of [true, false]) {
			const h = setup();
			await startBlind(h);
			if (done) h.round.roundRecorded(true);
			h.cable.options.endOutcome = { status: 'refused', reason: 'revert-failed', revertFailure: 'held' };
			h.cable.options.hold = { reason: 'loudness', curve: 'saved' };
			h.cable.options.confirmOutcome = failed;
			const gesture = { kind: 'cable-gesture' } as const;
			await h.round.end({ gesture });
			expect(h.round.view.phase).toBe('end-held');
			expect(await h.round.confirmHeld({ gesture })).toEqual(failed);
			expect(h.round.view.phase).not.toBe('ended');
			expect(h.round.view.endedReason).toBeNull();
			expect(h.round.running()).toBe(true);
			if (done) {
				expect(h.round.view.phase).toBe('done');
				expect(h.onvoid).not.toHaveBeenCalled();
			} else {
				expect(h.round.view).toMatchObject({ phase: 'paused', pause: 'end-failed' });
				expect(h.onvoid).toHaveBeenCalledWith('end-failed');
			}
		}
	});

	test('a refused confirmation that sent nothing keeps the held revert', async () => {
		const h = setup();
		await startBlind(h);
		h.cable.options.endOutcome = { status: 'refused', reason: 'revert-failed', revertFailure: 'held' };
		h.cable.options.hold = { reason: 'loudness', curve: 'saved' };
		await h.round.end({ gesture: { kind: 'cable-gesture' } });
		h.cable.port.confirmEndComparison.mockImplementationOnce(async () => ({
			status: 'refused',
			reason: 'gesture'
		}));
		expect(await h.round.confirmHeld({ gesture: null })).toMatchObject({ reason: 'gesture' });
		expect(h.round.view.phase).toBe('end-held');
	});

	test('a failed "Encerrar" during a round pauses and drops the round in play', async () => {
		const h = setup();
		await startBlind(h);
		h.cable.options.endOutcome = { status: 'refused', reason: 'revert-failed', revertFailure: 'error' };
		await h.round.end({ gesture: { kind: 'cable-gesture' } });
		expect(h.round.view).toMatchObject({ phase: 'paused', pause: 'end-failed' });
		expect(h.onvoid).toHaveBeenCalledWith('end-failed');
	});

	test('a cancelled held revert drops the round in play; a busy or unknown cable keeps it paused', async () => {
		const held = async (status: ComparisonCancelHoldStatus) => {
			const h = setup();
			await startBlind(h);
			h.cable.options.endOutcome = {
				status: 'refused',
				reason: 'revert-failed',
				revertFailure: 'held'
			};
			h.cable.options.hold = { reason: 'loudness', curve: 'saved' };
			h.cable.options.cancelStatus = status;
			await h.round.end({ gesture: { kind: 'cable-gesture' } });
			expect(h.round.view.phase).toBe('end-held');
			expect(h.round.cancelHeld()).toBe(status);
			return h;
		};
		const cleared = await held('cleared');
		expect(cleared.round.view).toMatchObject({ phase: 'paused', pause: 'end-failed' });
		expect(cleared.onvoid).toHaveBeenCalledWith('end-failed');
		for (const status of ['busy', 'unknown'] as const) {
			const h = await held(status);
			expect(h.round.view).toMatchObject({ phase: 'paused', pause: 'cancel-failed' });
			expect(h.onvoid).toHaveBeenCalledWith('cancel-failed');
			// Still on the cable: "Encerrar" or "Retomar" can go on from here.
			expect(h.round.running()).toBe(true);
		}
		const gone = await held('ended');
		expect(gone.round.view).toMatchObject({ phase: 'ended', endedReason: 'gone' });
	});

	test('"Encerrar" accepted ends there; "Encerrar sem voltar" keeps the curve', async () => {
		const h = setup();
		await startBlind(h);
		await h.round.end({ gesture: { kind: 'cable-gesture' } });
		expect(h.cable.port.endComparison).toHaveBeenLastCalledWith({
			revert: true,
			gesture: { kind: 'cable-gesture' }
		});
		expect(h.round.view).toMatchObject({ phase: 'ended', endedReason: 'reverted' });

		const kept = setup();
		await startBlind(kept);
		await kept.round.endKeep();
		expect(kept.round.view).toMatchObject({ phase: 'ended', endedReason: 'kept' });
	});
});

describe('an old preview on the cable (liveOrphan)', () => {
	const ORPHAN = { crc: -1, at: 5, deviceLabel: 'Cabo' };
	const begin = (h: ReturnType<typeof setup>) =>
		h.round.begin({
			gesture: { kind: 'cable-gesture' },
			confirmations: { volumeLowered: true },
			curves: CURVES,
			experimental: false
		});

	test('blocks the start (nothing sent); "Já desconectei" (cleared) unblocks it', async () => {
		const h = setup();
		h.cable.state = cableState(null, { liveOrphan: ORPHAN });
		expect(await begin(h)).toEqual({ status: 'refused', reason: 'live-elsewhere' });
		expect(h.cable.port.startComparison).not.toHaveBeenCalled();
		expect(h.cable.port.endComparison).not.toHaveBeenCalled();
		expect(h.round.view.phase).toBe('idle');
		// Dismissed (or replugged): the service clears the notice.
		h.cable.state = cableState(null, { liveOrphan: null });
		expect((await begin(h)).status).toBe('accepted');
		expect(h.round.view.phase).toBe('checking');
		// A state seen at the start with no orphan: rounds are not voided by it.
		h.round.observe(h.cable.state);
		expect(h.round.view.phase).toBe('checking');
	});

	test('"Retomar" is blocked the same way', async () => {
		const h = setup();
		await startBlind(h);
		await h.round.voidRound('stuck');
		h.cable.state = { ...h.cable.state, liveOrphan: ORPHAN };
		const calls = h.cable.port.startComparison.mock.calls.length;
		expect(
			await h.round.resume({ gesture: { kind: 'cable-gesture' }, confirmations: {} })
		).toEqual({ status: 'refused', reason: 'live-elsewhere' });
		expect(h.cable.port.startComparison).toHaveBeenCalledTimes(calls);
		expect(h.round.view).toMatchObject({ phase: 'paused', pause: 'stuck' });
	});

	test('an orphan appearing after the start voids the round in play', async () => {
		const h = setup();
		await startBlind(h);
		h.round.observe(h.cable.state);
		expect(h.round.view.phase).toBe('blind');
		h.cable.state = { ...h.cable.state, liveOrphan: ORPHAN };
		h.round.observe(h.cable.state);
		expect(h.round.view).toMatchObject({ phase: 'paused', pause: 'elsewhere' });
		expect(h.onvoid).toHaveBeenCalledWith('elsewhere');
	});
});

describe('a start that outlives its run', () => {
	function gate() {
		let open = () => undefined as void;
		const promise = new Promise<void>((resolve) => {
			open = resolve;
		});
		return { promise, open };
	}

	test('the check start lands after a reset: ended at once, nothing changes here', async () => {
		const h = setup();
		const start = gate();
		h.cable.options.startGate = start.promise;
		const begun = h.round.begin({
			gesture: { kind: 'cable-gesture' },
			confirmations: { volumeLowered: true },
			curves: CURVES,
			experimental: false
		});
		await h.clock.flush();
		expect(h.round.view.phase).toBe('starting');
		h.round.reset();
		start.open();
		expect(await begun).toMatchObject({ status: 'refused', reason: 'busy' });
		expect(h.cable.port.endComparison).toHaveBeenLastCalledWith({ revert: false });
		expect(h.cable.state.live?.comparison?.active).toBe(false);
		expect(h.round.view.phase).toBe('idle');
	});

	test('the blind start lands after the page went away (destroy): ended at once', async () => {
		const h = setup();
		h.round.audible(true);
		await h.round.begin({
			gesture: { kind: 'cable-gesture' },
			confirmations: { volumeLowered: true },
			curves: CURVES,
			experimental: false
		});
		const heard = h.round.playCheck(1);
		await h.clock.advance(300);
		await heard;
		const start = gate();
		h.cable.options.startGate = start.promise;
		const answered = h.round.answerCheck(true, { gesture: { kind: 'cable-gesture' } });
		await h.clock.flush();
		expect(h.round.view.phase).toBe('starting');
		await h.round.destroy();
		const ends = h.cable.port.endComparison.mock.calls.length;
		start.open();
		expect(await answered).toMatchObject({ status: 'refused', reason: 'busy' });
		expect(h.cable.port.endComparison).toHaveBeenCalledTimes(ends + 1);
		expect(h.cable.port.endComparison).toHaveBeenLastCalledWith({ revert: false });
		expect(h.cable.state.live?.comparison).toMatchObject({ active: false, blind: true });
		expect(h.round.view.phase).toBe('starting');
		expect(h.round.view.phase).not.toBe('blind');
	});

	test('"Encerrar sem voltar" while the start runs: the late start is ended too', async () => {
		const h = setup();
		const start = gate();
		h.cable.options.startGate = start.promise;
		const begun = h.round.begin({
			gesture: { kind: 'cable-gesture' },
			confirmations: { volumeLowered: true },
			curves: CURVES,
			experimental: false
		});
		await h.clock.flush();
		await h.round.endKeep();
		expect(h.round.view).toMatchObject({ phase: 'ended', endedReason: 'kept' });
		start.open();
		expect((await begun).status).toBe('refused');
		expect(h.cable.state.live?.comparison?.active).toBe(false);
		expect(h.round.view).toMatchObject({ phase: 'ended', endedReason: 'kept' });
	});
});

describe('the check counts an item heard only while the audio plays', () => {
	test('switching items without audio hears nothing; "Ouvi mudar" stays locked', async () => {
		const h = setup();
		const gesture = { kind: 'cable-gesture' } as const;
		await h.round.begin({
			gesture,
			confirmations: { volumeLowered: true },
			curves: CURVES,
			experimental: false
		});
		expect(h.round.view).toMatchObject({ checkPlaying: 0, checkHeard: [false, false] });
		const phone = h.round.playCheck(1);
		await h.clock.advance(300);
		await phone;
		expect(h.round.view.checkHeard).toEqual([false, false]);
		expect(await h.round.answerCheck(true, { gesture })).toMatchObject({ reason: 'busy' });
		// The audio plays with the telefone on the cable: heard.
		h.round.audible(true);
		expect(h.round.view.checkHeard).toEqual([false, true]);
		h.round.audible(false);
		const neutral = h.round.playCheck(0);
		await h.clock.advance(300);
		await neutral;
		expect(h.round.view.checkHeard).toEqual([false, true]);
		h.round.audible(true);
		expect(h.round.view.checkHeard).toEqual([true, true]);
		expect((await h.round.answerCheck(true, { gesture }))?.status).toBe('accepted');
	});

	test('the audio playing during a switch counts only once the item is on the cable', async () => {
		const h = setup();
		h.round.audible(true);
		await h.round.begin({
			gesture: { kind: 'cable-gesture' },
			confirmations: { volumeLowered: true },
			curves: CURVES,
			experimental: false
		});
		expect(h.round.view.checkHeard).toEqual([true, false]);
		const phone = h.round.playCheck(1);
		await h.clock.advance(299);
		expect(h.round.view.checkHeard).toEqual([true, false]);
		await h.clock.advance(1);
		await phone;
		expect(h.round.view.checkHeard).toEqual([true, true]);
	});
});

describe('telemetry', () => {
	test('rounds heard on the cable never reach S6; the pairs keep their four keys', async () => {
		const candidates = officialCandidates()
			.filter((c) => c.accepted)
			.slice(0, 2);
		let session = startSession(candidates, 3, 'other', () => 0);
		session = recordRound(session, [8, 3], () => 0);
		const browserRound = session.completed.at(-1);
		session = recordRound(session, [2, 9], () => 0);
		const cableRound = session.completed.at(-1);
		if (browserRound === undefined || cableRound === undefined) throw new Error('rounds');
		const cableRounds = new WeakSet<Round>([cableRound]);
		const filtered = s6Session(session, cableRounds);
		expect(filtered?.completed).toEqual([browserRound]);
		const pairs = await buildPairs(filtered);
		expect(pairs).toHaveLength(1);
		for (const pair of pairs) expect(Object.keys(pair)).toEqual(['a', 'b', 'choice', 'levelMatched']);
		// Only cable rounds: nothing at all is sent.
		const onlyCable = new WeakSet<Round>(session.completed);
		expect(await buildPairs(s6Session(session, onlyCable))).toEqual([]);
		expect(s6Session(null, onlyCable)).toBeNull();
	});
});
