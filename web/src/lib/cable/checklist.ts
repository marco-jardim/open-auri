/**
 * Pre-write checklist model (plan §3.1 N2/N3, T2.7). Pure: the context (clock, flash
 * state, last written level, journal status) is supplied by the caller.
 */
import { gateForWrite, isExperimentalKind, isUltrasonic, levelDb } from 'open-auri/safety';
import {
	FLASH_NOTICE_TEXT,
	LOUDNESS_WARNING_TEXT,
	canWriteNow,
	dailyNotice,
	localDateKey,
	loudnessWarning
} from 'open-auri/policy';
import { ANDROID_WRITE_VALIDATED } from './android-status.ts';
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

/** Added to the experimental text when the curve has a section above 20 kHz. */
export const ULTRASONIC_CONFIRMATION_TEXT =
	'Filtros acima de 20 kHz: confirme a gravação experimental.';

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
	'd:prefix-peak-full': 'cable_reason_d_prefix_peak_full',
	'd:prefix-peak-extended': 'cable_reason_d_prefix_peak_extended',
	'e:output-audible': 'cable_reason_e_output_audible',
	'e:output-extended': 'cable_reason_e_output_extended',
	'e:output-full': 'cable_reason_e_output_full',
	'f:codec': 'cable_reason_f_codec',
	'g:preamp': 'cable_reason_g_preamp',
	'k:kind-not-allowed': 'cable_reason_k_kind_not_allowed',
	'd7:pk-boost-above-16k': 'cable_reason_d7_pk_boost_above_16k',
	'd7:boost-q': 'cable_reason_d7_boost_q',
	'd7:boost-above-20k': 'cable_reason_d7_boost_above_20k'
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

/** The reasons a YOLO verdict waived, flagged `waived` (none for the standard profile). */
export function waivedViews(verdict: GateResult): ReasonView[] {
	if (verdict.profile !== 'yolo' || !Array.isArray(verdict.waivedReasons)) return [];
	return verdict.waivedReasons.map((reason) => ({ ...reasonView(reason), waived: true as const }));
}

/**
 * Lamps a–g and k from a gate verdict. After an early codec refusal the analysis lamps are
 * unknown. A lamp with blocking reasons fails; one with only reasons the YOLO profile waived is
 * `waived` (amber, "dispensado (YOLO)", values shown); class 1 never becomes `waived`.
 */
export function lampsFromGate(verdict: GateResult): Lamp[] {
	const reasons = verdict.reasons.map(reasonView);
	const waived = waivedViews(verdict);
	const analysed = verdict.metrics.sections !== undefined;
	return LAMP_IDS.map((id): Lamp => {
		const own = reasons.filter((reason) => lampOf(reason.code) === id);
		const ownWaived = waived.filter((reason) => lampOf(reason.code) === id);
		const state: LampState =
			own.length > 0
				? 'fail'
				: ownWaived.length > 0
					? 'waived'
					: analysed || id === 'f'
						? 'ok'
						: 'unknown';
		return { id, state, labelKey: LAMP_LABEL_KEYS[id], reasons: [...own, ...ownWaived] };
	});
}

/** Whether the curve uses kinds the official page never wrote (HS, LP, HP). */
export function hasExperimentalKinds(bands: readonly Readonly<Band>[]): boolean {
	return bands.some((band) => isExperimentalKind(band.kind));
}

/**
 * Whether the curve has a section above 20 kHz (core `isUltrasonic`): the official page never
 * wrote one either, so a write asks for the same experimental confirmation.
 */
export function hasUltrasonicBands(bands: readonly Readonly<Band>[]): boolean {
	return bands.some((band) => isUltrasonic(band));
}

function safeBandsTest(
	verdict: GateResult,
	raw: readonly Band[],
	test: (bands: readonly Readonly<Band>[]) => boolean
): boolean {
	if (verdict.metrics.bands !== undefined) return test(verdict.metrics.bands);
	try {
		return Array.isArray(raw) && test(raw);
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
 * same input (display only; `write()` always re-evaluates); a verdict of another profile
 * is ignored and the gate runs again.
 *
 * Modo YOLO (`input.profile === 'yolo'`): the gate runs with the YOLO profile (class 2
 * waived, class 1 and `d:prefix-peak-full` block) and two more items are required:
 * `yolo-session` (YOLO on in this tab, phrase typed: `context.yoloSession`) and
 * `yolo-write` (the per-write confirmation, on every write).
 */
export function evaluateChecklist(
	input: ChecklistInput,
	context: ChecklistContext,
	gate?: GateResult
): ChecklistResult {
	const experimental = input.experimental === true;
	const yolo = input.profile === 'yolo';
	const profile = yolo ? 'yolo' : 'standard';
	const options = yolo ? { experimental, profile: 'yolo' as const } : { experimental };
	// A reused verdict must come from the same profile (a YOLO verdict never approves a
	// standard write, and a standard one never stands in for YOLO).
	const sameProfile = gate !== undefined && (gate.profile === 'yolo') === yolo;
	const verdict =
		gate !== undefined && sameProfile ? gate : gateForWrite(input.bands, input.preampDb, options);
	const reasons = verdict.reasons.map(reasonView);
	const waivedReasons = waivedViews(verdict);
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

	// The confirmation covers HS/LP/HP and any section above 20 kHz; the gate's own
	// `experimental` option (input.experimental) stays kind-based.
	const experimentalUltrasonic = safeBandsTest(verdict, input.bands, hasUltrasonicBands);
	const experimentalRequired =
		safeBandsTest(verdict, input.bands, hasExperimentalKinds) || experimentalUltrasonic;
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
		{ id: 'spacing', required: true, satisfied: spacing.ok },
		{
			id: 'yolo-session',
			required: yolo,
			satisfied: !yolo || context.yoloSession === true
		},
		{
			id: 'yolo-write',
			required: yolo,
			satisfied: !yolo || confirmations.yoloWrite === true
		}
	];
	// Keep desktop and simulated item lists exactly unchanged, including optional items.
	if (context.cableMode === 'native') {
		items.push({
			id: 'android-untested',
			required: !(context.androidWriteValidated ?? ANDROID_WRITE_VALIDATED),
			satisfied: confirmations.androidUntested === true
		});
	}

	return {
		profile,
		waived: yolo && Array.isArray(verdict.waived) ? [...verdict.waived] : [],
		waivedReasons,
		gateOk: verdict.ok,
		lamps,
		reasons,
		crc: crc !== null && Number.isInteger(crc) ? crc : null,
		snapshot,
		newLevelDb,
		loudness: { ...loudness, text: LOUDNESS_WARNING_TEXT },
		experimentalRequired,
		experimentalText: experimentalUltrasonic
			? `${EXPERIMENTAL_CONFIRMATION_TEXT} ${ULTRASONIC_CONFIRMATION_TEXT}`
			: EXPERIMENTAL_CONFIRMATION_TEXT,
		spacing,
		counters: flashCountersOf(context.flash, context.nowMs),
		dailyNotice: { show: dailyNotice(context.flash, context.nowMs), text: FLASH_NOTICE_TEXT },
		items,
		canWrite: items.every((item) => !item.required || item.satisfied)
	};
}
