/**
 * Pre-write checklist model (plan §3.1 N2/N3, T2.7). Pure: the context (clock, flash
 * state, last written level, journal status) is supplied by the caller.
 */
import { gateForWrite, isExperimentalKind, levelDb } from 'open-auri/safety';
import {
	FLASH_NOTICE_TEXT,
	LOUDNESS_WARNING_TEXT,
	canWriteNow,
	dailyNotice,
	localDateKey,
	loudnessWarning
} from 'open-auri/policy';
import type {
	Band,
	ChecklistContext,
	ChecklistInput,
	ChecklistItem,
	ChecklistResult,
	FlashState,
	GateReason,
	GateResult,
	JournalEntry,
	Lamp,
	LampId,
	LampLabelKey,
	LampState,
	ReasonCode,
	ReasonMessageKey,
	ReasonView
} from './types.ts';

export { FLASH_NOTICE_TEXT, LOUDNESS_WARNING_TEXT };

/** Plan §3.4, literal. */
export const EXPERIMENTAL_CONFIRMATION_TEXT =
	'Esta curva usa tipos que a página oficial nunca gravou. Os coeficientes estão dentro do envelope observado, mas o firmware nunca recebeu esses formatos.';

/** Gate reason code → message key, for every code the gate emits. */
export const REASON_MESSAGE_KEYS: Readonly<Record<ReasonCode, ReasonMessageKey>> = Object.freeze({
	'a:b0': 'cable_reason_a_b0',
	'a:b2': 'cable_reason_a_b2',
	'a:-a1': 'cable_reason_a_neg_a1',
	'a:b1': 'cable_reason_a_b1',
	'a:-a2': 'cable_reason_a_neg_a2',
	'b:pole-radius': 'cable_reason_b_pole_radius',
	'c:section-peak': 'cable_reason_c_section_peak',
	'd:prefix-peak': 'cable_reason_d_prefix_peak',
	'e:output-audible': 'cable_reason_e_output_audible',
	'e:output-full': 'cable_reason_e_output_full',
	'f:codec': 'cable_reason_f_codec',
	'g:preamp': 'cable_reason_g_preamp',
	'k:kind-not-allowed': 'cable_reason_k_kind_not_allowed',
	'd7:pk-boost-above-16k': 'cable_reason_d7_pk_boost_above_16k',
	'd7:boost-q': 'cable_reason_d7_boost_q'
});

/** Gate lamps a–g plus `k` (kinds and D7 editing limits, part of the gate contract). */
export const LAMP_IDS: readonly LampId[] = Object.freeze(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'k']);

const LAMP_LABEL_KEYS: Readonly<Record<LampId, LampLabelKey>> = Object.freeze({
	a: 'cable_lamp_a',
	b: 'cable_lamp_b',
	c: 'cable_lamp_c',
	d: 'cable_lamp_d',
	e: 'cable_lamp_e',
	f: 'cable_lamp_f',
	g: 'cable_lamp_g',
	k: 'cable_lamp_k'
});

/** Lamp of a reason code (`d7:*` and `k:*` share lamp `k`). */
export function lampOf(code: string): LampId {
	const prefix = code.split(':')[0];
	if (prefix === 'd7' || prefix === 'k') return 'k';
	return (LAMP_IDS as readonly string[]).includes(prefix) ? (prefix as LampId) : 'f';
}

function finiteOrNull(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function reasonView(reason: GateReason): ReasonView {
	const key = (REASON_MESSAGE_KEYS as Readonly<Record<string, ReasonMessageKey>>)[reason.code];
	return {
		code: reason.code,
		messageKey: key ?? 'cable_reason_unknown',
		stage: typeof reason.stage === 'number' ? reason.stage : null,
		value: finiteOrNull(reason.value),
		limit: finiteOrNull(reason.limit)
	};
}

/** Lamps a–g and k from a gate verdict. After an early codec refusal the analysis lamps are unknown. */
export function lampsFromGate(verdict: GateResult): Lamp[] {
	const reasons = verdict.reasons.map(reasonView);
	const analysed = verdict.metrics.sections !== undefined;
	return LAMP_IDS.map((id): Lamp => {
		const own = reasons.filter((reason) => lampOf(reason.code) === id);
		const state: LampState = own.length > 0 ? 'fail' : analysed || id === 'f' ? 'ok' : 'unknown';
		return { id, state, labelKey: LAMP_LABEL_KEYS[id], reasons: own };
	});
}

/** Whether the curve uses kinds the official page never wrote (HS, LP, HP). */
export function hasExperimentalKinds(bands: readonly Readonly<Band>[]): boolean {
	return bands.some((band) => isExperimentalKind(band.kind));
}

function safeExperimentalKinds(verdict: GateResult, raw: readonly Band[]): boolean {
	if (verdict.metrics.bands !== undefined) return hasExperimentalKinds(verdict.metrics.bands);
	try {
		return Array.isArray(raw) && hasExperimentalKinds(raw);
	} catch {
		// Unreadable bands: the gate already refuses them (f:codec); be conservative.
		return true;
	}
}

function safeLevelDb(
	bands: readonly Readonly<Band>[] | undefined,
	preampDb: number
): number | null {
	if (bands === undefined) return null;
	try {
		return finiteOrNull(levelDb(bands, preampDb));
	} catch {
		return null;
	}
}

function safeCount(value: unknown): number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Session / local day / total counters shown by the checklist (one source for every view). */
export function flashCountersOf(flash: FlashState, nowMs: number): ChecklistResult['counters'] {
	const today = localDateKey(nowMs);
	return {
		session: safeCount(flash.session),
		day: flash.day.date === today ? safeCount(flash.day.count) : 0,
		total: safeCount(flash.total)
	};
}

/** `levelDb` of a journaled curve, computed exactly like the checklist's `newLevelDb`. */
export function writtenLevelDb(entry: Pick<JournalEntry, 'bands' | 'preampDb'>): number | null {
	return safeLevelDb(entry.bands, entry.preampDb);
}

/**
 * `levelDb` of the last curve that reached the cable: the newest `ok` journal entry (real
 * writes only; `simulated` and `interrupted` entries are skipped). Null when there is none.
 */
export function lastWrittenLevelDbOf(entries: readonly JournalEntry[]): number | null {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry !== undefined && entry.status === 'ok') return writtenLevelDb(entry);
	}
	return null;
}

/**
 * Evaluates the checklist. `gate` may be passed to reuse a verdict computed for the
 * same input (display only; `write()` always re-evaluates).
 */
export function evaluateChecklist(
	input: ChecklistInput,
	context: ChecklistContext,
	gate?: GateResult
): ChecklistResult {
	const experimental = input.experimental === true;
	const verdict = gate ?? gateForWrite(input.bands, input.preampDb, { experimental });
	const reasons = verdict.reasons.map(reasonView);
	const lamps = lampsFromGate(verdict);
	const snapshot = verdict.metrics.bands ?? null;
	const crc = verdict.metrics.payloadCrc === undefined ? null : Number(verdict.metrics.payloadCrc);

	const newLevelDb = safeLevelDb(verdict.metrics.bands, input.preampDb);
	const loudness = loudnessWarning({
		newLevelDb: newLevelDb ?? Number.NaN,
		lastWrittenLevelDb: context.lastWrittenLevelDb,
		sessionWriteCount: context.sessionWriteCount,
		lastJournalStatus: context.lastJournalStatus
	});

	const experimentalRequired = safeExperimentalKinds(verdict, input.bands);
	const spacing = canWriteNow(context.flash, context.nowMs);
	const confirmations = input.confirmations;

	const items: ChecklistItem[] = [
		{ id: 'gate', required: true, satisfied: verdict.ok },
		{ id: 'volume', required: true, satisfied: confirmations.volumeLowered === true },
		{ id: 'connection', required: true, satisfied: confirmations.keepConnected === true },
		{
			id: 'experimental',
			required: experimentalRequired,
			satisfied: !experimentalRequired || confirmations.experimental === true
		},
		{ id: 'spacing', required: true, satisfied: spacing.ok }
	];

	return {
		gateOk: verdict.ok,
		lamps,
		reasons,
		crc: crc !== null && Number.isInteger(crc) ? crc : null,
		snapshot,
		newLevelDb,
		loudness: { ...loudness, text: LOUDNESS_WARNING_TEXT },
		experimentalRequired,
		experimentalText: EXPERIMENTAL_CONFIRMATION_TEXT,
		spacing,
		counters: flashCountersOf(context.flash, context.nowMs),
		dailyNotice: { show: dailyNotice(context.flash, context.nowMs), text: FLASH_NOTICE_TEXT },
		items,
		canWrite: items.every((item) => !item.required || item.satisfied)
	};
}
