/** Message lookups and number formatting shared by the cable components. */
import { m } from '#lib/paraglide/messages.js';
import { getLocale } from '#lib/paraglide/runtime.js';
import { NativeFreshnessError } from '#lib/cable/native-freshness.ts';
import { mayApplyUpdate } from '#lib/pwa/strategy.ts';
import type {
	LampLabelKey,
	LampState,
	QueueItemStatus,
	ReasonView,
	QueueOutcome,
	RefusalReason,
	WriteOutcome
} from '#lib/cable/types.ts';

export const lampLabel: Record<LampLabelKey, () => string> = {
	cable_lamp_a: () => m.cable_lamp_a(),
	cable_lamp_b: () => m.cable_lamp_b(),
	cable_lamp_c: () => m.cable_lamp_c(),
	cable_lamp_d: () => m.cable_lamp_d(),
	cable_lamp_e: () => m.cable_lamp_e(),
	cable_lamp_f: () => m.cable_lamp_f(),
	cable_lamp_g: () => m.cable_lamp_g(),
	cable_lamp_k: () => m.cable_lamp_k()
};

export const lampState: Record<LampState, () => string> = {
	ok: () => m.cable_lamp_state_ok(),
	fail: () => m.cable_lamp_state_fail(),
	// Modo YOLO: a class-2 criterion the YOLO profile waived (amber, values still shown).
	waived: () => m.yolo_lamp_waived(),
	unknown: () => m.cable_lamp_state_unknown()
};

const reasonText: Record<ReasonView['messageKey'], () => string> = {
	cable_reason_a_b0: () => m.cable_reason_a_b0(),
	cable_reason_a_b2: () => m.cable_reason_a_b2(),
	cable_reason_a_neg_a1: () => m.cable_reason_a_neg_a1(),
	cable_reason_a_b1: () => m.cable_reason_a_b1(),
	cable_reason_a_neg_a2: () => m.cable_reason_a_neg_a2(),
	cable_reason_b_pole_radius: () => m.cable_reason_b_pole_radius(),
	cable_reason_c_section_peak: () => m.cable_reason_c_section_peak(),
	cable_reason_d_prefix_peak: () => m.cable_reason_d_prefix_peak(),
	cable_reason_d_prefix_peak_full: () => m.cable_reason_d_prefix_peak_full(),
	cable_reason_d_prefix_peak_extended: () => m.cable_reason_d_prefix_peak_extended(),
	cable_reason_e_output_audible: () => m.cable_reason_e_output_audible(),
	cable_reason_e_output_extended: () => m.cable_reason_e_output_extended(),
	cable_reason_e_output_full: () => m.cable_reason_e_output_full(),
	cable_reason_f_codec: () => m.cable_reason_f_codec(),
	cable_reason_g_preamp: () => m.cable_reason_g_preamp(),
	cable_reason_k_kind_not_allowed: () => m.cable_reason_k_kind_not_allowed(),
	cable_reason_d7_pk_boost_above_16k: () => m.cable_reason_d7_pk_boost_above_16k(),
	cable_reason_d7_boost_q: () => m.cable_reason_d7_boost_q(),
	cable_reason_d7_boost_above_20k: () => m.cable_reason_d7_boost_above_20k(),
	cable_reason_unknown: () => m.cable_reason_unknown()
};

export const queueStatus: Record<QueueItemStatus, () => string> = {
	pending: () => m.cable_queue_status_pending(),
	writing: () => m.cable_queue_status_writing(),
	sent: () => m.cable_queue_status_sent(),
	ok: () => m.cable_queue_status_ok(),
	simulated: () => m.cable_queue_status_simulated(),
	interrupted: () => m.cable_queue_status_interrupted(),
	failed: () => m.cable_queue_status_failed(),
	skipped: () => m.cable_queue_status_skipped()
};

export const refusalText: Record<RefusalReason, () => string> = {
	gesture: () => m.cable_refused_gesture(),
	busy: () => m.cable_refused_busy(),
	'no-device': () => m.cable_refused_no_device(),
	'unknown-device': () => m.cable_refused_unknown_device(),
	checklist: () => m.cable_refused_checklist(),
	gate: () => m.cable_refused_gate(),
	unusable: () => m.cable_refused_unusable(),
	aborted: () => m.cable_refused_aborted(),
	'interrupted-elsewhere': () => m.cable_refused_interrupted_elsewhere(),
	'yolo-queue': () => m.yolo_queue_refused(),
	error: () => m.cable_refused_error()
};

/** Display names of waived criteria for the per-write YOLO confirmation, e.g. "(c), (g)". */
export function waivedCriteriaText(codes: readonly string[]): string {
	const lamps = [...new Set(codes.map((code) => code.split(':')[0]))].map((prefix) =>
		prefix === 'd7' ? 'k' : prefix
	);
	const unique = [...new Set(lamps)];
	return unique.length === 0 ? m.yolo_waived_none() : unique.map((id) => `(${id})`).join(', ');
}

/** Locale-aware decimal (comma in pt-BR, point in en-US); negative values use a real minus sign. */
export function formatNumber(value: number, digits = 1, signed = false): string {
	const text = new Intl.NumberFormat(getLocale(), {
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
		signDisplay: signed ? 'exceptZero' : 'auto'
	}).format(value);
	return text.replace('-', '−');
}

export function formatCrc(crc: number): string {
	return `0x${crc.toString(16).toUpperCase().padStart(4, '0')}`;
}

export function describeReason(reason: ReasonView): string {
	const parts: string[] = [];
	if (reason.stage !== null) {
		parts.push(`${m.cable_reason_stage({ stage: String(reason.stage) })}:`);
	}
	parts.push(reasonText[reason.messageKey]());
	if (reason.value !== null && reason.limit !== null) {
		parts.push(
			`(${m.cable_reason_value_limit({
				value: formatNumber(reason.value, 2),
				limit: formatNumber(reason.limit, 2)
			})})`
		);
	}
	return parts.join(' ');
}

/** Only freshness refusals offer a reload, never unrelated cable failures. */
export function isFreshnessRefusal(outcome: WriteOutcome | QueueOutcome): boolean {
	return outcome.status === 'refused' && outcome.error instanceof NativeFreshnessError;
}

/** The same last-moment write guard as the PWA update flow; never schedules a later reload. */
export function reloadWhenSafe(reload: () => void = () => window.location.reload()): void {
	if (typeof window !== 'undefined' && mayApplyUpdate(window.__oaWriteInProgress)) reload();
}

/**
 * Short, non-blocking notice for a native write that went ahead offline on the last live
 * confirmation of this build (with its date); null otherwise.
 */
export function lastGoodNotice(outcome: WriteOutcome | QueueOutcome): string | null {
	if (outcome.status === 'refused') return null;
	const freshness = outcome.freshness;
	if (freshness?.basis !== 'last-good') return null;
	const date = new Intl.DateTimeFormat(getLocale(), {
		dateStyle: 'short',
		timeStyle: 'short'
	}).format(freshness.checkedAt);
	return m.cable_native_last_good({ date });
}

/** Human-readable outcome of a write or a queue, followed by the offline last-good notice. */
export function describeOutcome(outcome: WriteOutcome | QueueOutcome): string {
	const text = outcomeText(outcome);
	const notice = lastGoodNotice(outcome);
	return notice === null ? text : `${text} ${notice}`;
}

function outcomeText(outcome: WriteOutcome | QueueOutcome): string {
	if (outcome.status === 'refused') {
		if (outcome.error instanceof NativeFreshnessError) {
			return outcome.error.reason === 'newer'
				? m.cable_native_reload_newer()
				: m.cable_native_reload_unavailable();
		}
		return refusalText[outcome.reason]();
	}
	if (outcome.status === 'done') {
		return outcome.items
			.map((item) => `${item.deviceLabel}: ${queueStatus[item.status]()}`)
			.join('; ');
	}
	const crc = formatCrc(outcome.crc);
	if (outcome.status === 'ok') return m.cable_result_ok({ crc });
	if (outcome.status === 'simulated') return m.cable_result_simulated({ crc });
	return m.cable_result_interrupted();
}
