import { commitReport, encodePayload, REPORT_COUNT, reportsFromPayload } from 'open-auri/dsp';
import { REPORT_GAP_MS, SETTLE_MS } from 'open-auri/transport';
import { localDateKey } from 'open-auri/policy';
import type { Curve } from '#lib/charts/response.ts';
import type { CableState, FlashState, WriteOutcome } from '#lib/cable/types.ts';

export const RACK_STATES = [
	'unsupported',
	'simulated',
	'disconnected',
	'connecting',
	'connected',
	'writing',
	'interrupted'
] as const;
export type RackState = (typeof RACK_STATES)[number];

/** A projection of the shared service, not a second connection state machine. */
export function rackState(cable: CableState | null, realRequested = false): RackState {
	if (cable === null) return 'disconnected';
	if (cable.writing) return 'writing';
	if (cable.connection === 'connecting') return 'connecting';
	if (cable.rescue !== null || cable.lastOutcome?.status === 'interrupted') return 'interrupted';
	if (cable.mode === 'simulated' && realRequested) return 'unsupported';
	if (cable.connection === 'connected') return 'connected';
	return cable.mode === 'simulated' ? 'simulated' : 'disconnected';
}

export function encoderData(curve: Curve) {
	try {
		const payload = encodePayload(curve.bands, curve.preampDb);
		return {
			ok: true as const,
			payload,
			crc: payload[218] | (payload[219] << 8),
			regions: [
				{ kind: 'header' as const, offset: 0, bytes: payload.slice(0, 14) },
				{ kind: 'preamp' as const, offset: 14, bytes: payload.slice(14, 18) },
				{ kind: 'coefficients' as const, offset: 18, bytes: payload.slice(18, 218) },
				{ kind: 'crc' as const, offset: 218, bytes: payload.slice(218, 220) }
			]
		};
	} catch (error) {
		return { ok: false as const, error };
	}
}

/** Nominal positions are protocol delays, never invented per-report measurements. */
export function tapeTimeline(curve: Curve, outcome: WriteOutcome | null = null) {
	// An interrupted simulation has no journal snapshot. Do not attribute current editor
	// bytes to that attempt; in that case only the explicitly labeled dry-run is available.
	const written =
		outcome !== null && outcome.status !== 'refused' && outcome.entry !== null ? outcome : null;
	const source = written?.entry ?? curve;
	const payload = encodePayload(source.bands, source.preampDb);
	const reports = reportsFromPayload(payload).map((bytes, index) => ({
		index,
		bytes,
		atMs: index * REPORT_GAP_MS,
		endMs: (index + 1) * REPORT_GAP_MS,
		accepted: written === null ? null : index < written.result.reportsSent
	}));
	const settleAtMs = REPORT_COUNT * REPORT_GAP_MS;
	const commitAtMs = settleAtMs + SETTLE_MS;
	return {
		reports,
		settleAtMs,
		commitAtMs,
		commitBytes: commitReport(),
		status: written?.status ?? ('dry-run' as const),
		committed: written?.result.committed ?? false,
		measuredMs: written === null ? null : written.result.finishedAt - written.result.startedAt,
		// For interruption, replay stops at the measured endpoint, not at a fictitious commit.
		durationMs:
			written === null
				? commitAtMs
				: Math.max(0, written.result.finishedAt - written.result.startedAt)
	};
}

export function flashCounters(state: FlashState, now: number) {
	return {
		session: state.session,
		day: state.day.date === localDateKey(now) ? state.day.count : 0,
		total: state.total
	};
}

/** Do not truncate significant digits when a mechanical counter fills up. */
export function counterDigits(value: number): string[] {
	return String(Math.max(0, Math.floor(value)))
		.padStart(5, '0')
		.split('');
}
