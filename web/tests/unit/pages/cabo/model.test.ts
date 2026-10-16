import { describe, expect, test } from 'vitest';
import { NEUTRO, PADRAO_AURI } from 'open-auri/catalog';
import { encodePayload, PREAMBLE, reportsFromPayload } from 'open-auri/dsp';
import { localDateKey } from 'open-auri/policy';
import type { CableState, FlashState, Written } from '#lib/cable/types.ts';
import {
	counterDigits,
	encoderData,
	flashCounters,
	rackState,
	RACK_STATES,
	tapeTimeline
} from '#lib/components/pages/cabo/model.ts';

const disconnected: CableState = {
	mode: 'real',
	connection: 'disconnected',
	device: null,
	deviceLabel: null,
	devices: [],
	deviceLabels: [],
	writing: false,
	rescue: null,
	queue: null,
	lastOutcome: null,
	error: null
};

function outcome(status: Written['status'] = 'ok'): Written {
	return {
		status,
		simulated: status === 'simulated',
		result: {
			status: status === 'interrupted' ? 'interrupted' : 'ok',
			startedAt: 100,
			finishedAt: status === 'interrupted' ? 161 : 490,
			reportsSent: status === 'interrupted' ? 4 : 9,
			committed: status !== 'interrupted',
			crc: PADRAO_AURI.crc
		},
		entry: {
			schema: 1,
			at: 1000,
			name: PADRAO_AURI.label,
			preampDb: PADRAO_AURI.preampDb,
			bands: PADRAO_AURI.bands.map((band) => ({ ...band })),
			crc: PADRAO_AURI.crc,
			status,
			device: 'USB DSP Audio'
		},
		deviceLabel: 'USB DSP Audio',
		crc: PADRAO_AURI.crc,
		levelDb: -2.66
	};
}

describe('rack state projection', () => {
	test('covers every state without opening a device', () => {
		const states = [
			rackState({ ...disconnected, mode: 'simulated' }, true),
			rackState({ ...disconnected, mode: 'simulated' }),
			rackState(disconnected),
			rackState({ ...disconnected, connection: 'connecting' }),
			rackState({ ...disconnected, connection: 'connected' }),
			rackState({ ...disconnected, connection: 'connected', writing: true }),
			rackState({ ...disconnected, lastOutcome: outcome('interrupted') })
		];
		expect(states).toEqual(RACK_STATES);
		expect(rackState(null)).toBe('disconnected');
	});

	test('follows connect, write, interruption, reconnect and successful recovery', () => {
		const state = { ...disconnected };
		expect(rackState(state)).toBe('disconnected');
		state.connection = 'connecting';
		expect(rackState(state)).toBe('connecting');
		state.connection = 'connected';
		expect(rackState(state)).toBe('connected');
		state.writing = true;
		expect(rackState(state)).toBe('writing');
		state.writing = false;
		state.lastOutcome = outcome('interrupted');
		expect(rackState(state)).toBe('interrupted');
		state.connection = 'connecting';
		expect(rackState(state)).toBe('connecting');
		state.connection = 'connected';
		state.writing = true;
		expect(rackState(state)).toBe('writing');
		state.writing = false;
		state.lastOutcome = outcome();
		expect(rackState(state)).toBe('connected');
		state.connection = 'disconnected';
		expect(rackState(state)).toBe('disconnected');
	});

	test('retains restored interruption, and simulated connection never claims real mode', () => {
		expect(
			rackState({ ...disconnected, rescue: { at: 1, deviceLabel: 'cable', reportsSent: 3 } })
		).toBe('interrupted');
		expect(rackState({ ...disconnected, mode: 'simulated', connection: 'connected' })).toBe(
			'connected'
		);
		expect(rackState({ ...disconnected, mode: 'simulated', connection: 'connecting' }, true)).toBe(
			'connecting'
		);
	});
});

describe('encoder', () => {
	test('shows all four exact, contiguous payload regions from the official preset', () => {
		const data = encoderData(PADRAO_AURI);
		expect(data.ok).toBe(true);
		if (!data.ok) throw data.error;
		expect(data.regions.map(({ offset, bytes }) => [offset, bytes.length])).toEqual([
			[0, 14],
			[14, 4],
			[18, 200],
			[218, 2]
		]);
		expect(data.regions.flatMap(({ bytes }) => bytes)).toEqual(
			encodePayload(PADRAO_AURI.bands, PADRAO_AURI.preampDb)
		);
		expect(data.regions[0].bytes).toEqual(PREAMBLE);
		expect(data.crc).toBe(PADRAO_AURI.crc);
	});

	test('updates with the editor and reports encoding errors instead of fake bytes', () => {
		const neutral = encoderData(NEUTRO);
		expect(neutral.ok && neutral.crc).toBe(0x4fff);
		expect(encoderData({ ...NEUTRO, preampDb: 1 }).ok).toBe(false);
	});
});

describe('transport tape', () => {
	test('uses nine 16 ms pauses, then 150 ms settle, including the last report pause', () => {
		const tape = tapeTimeline(NEUTRO);
		expect(tape.reports.map(({ atMs }) => atMs)).toEqual([0, 16, 32, 48, 64, 80, 96, 112, 128]);
		expect(tape.reports.map(({ endMs, atMs }) => endMs - atMs)).toEqual(Array(9).fill(16));
		expect(tape.settleAtMs).toBe(144);
		expect(tape.commitAtMs - tape.settleAtMs).toBe(150);
		expect(tape.durationMs).toBe(294);
		expect(tape.commitBytes).toHaveLength(31);
		expect(tape.status).toBe('dry-run');
		expect(tape.committed).toBe(false);
		expect(tape.measuredMs).toBeNull();
		expect(tape.reports.every(({ accepted }) => accepted === null)).toBe(true);
	});

	test('uses measured endpoints and the sent snapshot, not a changed editor', () => {
		const tape = tapeTimeline(NEUTRO, outcome());
		expect(tape.measuredMs).toBe(390);
		expect(tape.durationMs).toBe(390);
		expect(tape.reports.map(({ bytes }) => bytes)).toEqual(
			reportsFromPayload(encodePayload(PADRAO_AURI.bands, PADRAO_AURI.preampDb))
		);
		expect(tape.reports.every(({ accepted }) => accepted)).toBe(true);
		expect(tape.committed).toBe(true);
		expect(tape.status).toBe('ok');
	});

	test('never fabricates acceptance or commit after an interruption or refusal', () => {
		const tape = tapeTimeline(NEUTRO, outcome('interrupted'));
		expect(tape.status).toBe('interrupted');
		expect(tape.reports.map(({ accepted }) => accepted)).toEqual([
			true,
			true,
			true,
			true,
			false,
			false,
			false,
			false,
			false
		]);
		expect(tape.durationMs).toBe(61);
		expect(tape.committed).toBe(false);
		expect(tapeTimeline(NEUTRO, { status: 'refused', reason: 'gesture' }).status).toBe('dry-run');
		expect(tapeTimeline(NEUTRO, outcome('simulated')).status).toBe('simulated');
		expect(
			tapeTimeline(NEUTRO, { ...outcome('interrupted'), simulated: true, entry: null }).status
		).toBe('dry-run');
	});
});

test('flash counters read shared real state, roll over the local day, and keep large digits', () => {
	const now = new Date(2026, 9, 16, 12).getTime();
	const state: FlashState = {
		session: 3,
		day: { date: localDateKey(now), count: 51 },
		total: 123456,
		lastWriteAt: now - 5000
	};
	const before = structuredClone(state);
	expect(flashCounters(state, now)).toEqual({ session: 3, day: 51, total: 123456 });
	expect(flashCounters(state, new Date(2026, 9, 17, 12).getTime())).toEqual({
		session: 3,
		day: 0,
		total: 123456
	});
	expect(state).toEqual(before);
	expect(counterDigits(3).join('')).toBe('00003');
	expect(counterDigits(123456).join('')).toBe('123456');
});
