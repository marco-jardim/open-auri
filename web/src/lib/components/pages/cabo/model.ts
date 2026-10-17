import { commitReport, encodePayload, REPORT_COUNT, reportsFromPayload } from 'open-auri/dsp';
import { REPORT_GAP_MS, SETTLE_MS } from 'open-auri/transport';
import { localDateKey } from 'open-auri/policy';
import { PRESETS_BY_ID } from 'open-auri/catalog';
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

/** Nodes of the WebHID state diagram (U1), in drawing order. */
export const DIAGRAM_NODES = [
	'unsupported',
	'disconnected',
	'connecting',
	'connected',
	'writing',
	'written',
	'interrupted'
] as const;
export type DiagramNode = (typeof DIAGRAM_NODES)[number];

/**
 * The lit node of the diagram: the rack state itself, except that the simulated rack without a
 * cable is the "no cable" node (the mode is shown by the switch, not by a second node).
 */
export function diagramNode(state: RackState): DiagramNode {
	return state === 'simulated' ? 'disconnected' : state;
}

/** Whether the last attempt reached its commit (lights the "written" node as a trace). */
export function lastWritten(cable: CableState | null): boolean {
	const outcome = cable?.lastOutcome ?? null;
	return (
		outcome !== null &&
		(outcome.status === 'ok' || outcome.status === 'simulated') &&
		outcome.result.committed
	);
}

/**
 * Live progress of a write, if the service reports it (`cable:progress` on `service.events`,
 * detail `{ reportsSent, committed }`). Until the service dispatches it, nothing is invented:
 * the tape shows the real result when the write ends.
 */
export const CABLE_PROGRESS_EVENT = 'cable:progress';
export interface TapeProgress {
	/** Data reports the cable accepted so far, 0..9. */
	reportsSent: number;
	committed: boolean;
}

export function parseProgress(detail: unknown): TapeProgress | null {
	if (typeof detail !== 'object' || detail === null) return null;
	const { reportsSent, committed } = detail as Record<string, unknown>;
	if (
		typeof reportsSent !== 'number' ||
		!Number.isInteger(reportsSent) ||
		reportsSent < 0 ||
		reportsSent > REPORT_COUNT ||
		typeof committed !== 'boolean'
	) {
		return null;
	}
	return { reportsSent, committed };
}

/** Reports a nominal timeline has passed at `elapsedMs` (0 before it starts). */
export function reportsPassed(atMs: readonly number[], elapsedMs: number): number {
	if (!(elapsedMs > 0)) return 0;
	return atMs.filter((at) => elapsedMs >= at).length;
}

/** Letter of a connected cable in the rack list (A, B, C…). */
export function cableLetter(index: number): string {
	return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
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

export interface ExampleBox {
	id: string;
	name: string;
	bands: Curve['bands'];
	preampDb: number;
	/** CRC computed from the preset's own payload bytes, never typed in. */
	crc: number;
}

/**
 * Three official presets shown as EXAMPLE tape boxes in the empty journal (spec §4.4). They are
 * illustrations of what a box looks like: not journal entries, never written, not loadable.
 */
export function exampleBoxes(): ExampleBox[] {
	const presets = Object.values(PRESETS_BY_ID);
	const wanted = ['natural', 'neutro', 'padrao'];
	const chosen = [
		...wanted.flatMap((id) => (PRESETS_BY_ID[id] === undefined ? [] : [PRESETS_BY_ID[id]])),
		...presets.filter((preset) => !wanted.includes(preset.id))
	].slice(0, 3);
	return chosen.flatMap((preset) => {
		const encoded = encoderData(preset);
		return encoded.ok
			? [
					{
						id: preset.id,
						name: preset.label,
						bands: preset.bands,
						preampDb: preset.preampDb,
						crc: encoded.crc
					}
				]
			: [];
	});
}

/** Do not truncate significant digits when a mechanical counter fills up. */
export function counterDigits(value: number): string[] {
	return String(Math.max(0, Math.floor(value)))
		.padStart(5, '0')
		.split('');
}
