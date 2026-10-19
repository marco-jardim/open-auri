import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { levelDb } from 'open-auri/safety';
import { NEUTRAL_BANDS } from 'open-auri/dsp';
import { FLASH_NOTICE_TEXT, LOUDNESS_WARNING_TEXT, localDateKey } from 'open-auri/policy';
import {
	EXPERIMENTAL_CONFIRMATION_TEXT,
	LAMP_IDS,
	REASON_MESSAGE_KEYS,
	ULTRASONIC_CONFIRMATION_TEXT,
	evaluateChecklist,
	hasExperimentalKinds,
	hasUltrasonicBands,
	lampOf
} from '../../../src/lib/cable/checklist.ts';
import type {
	Band,
	ChecklistContext,
	ChecklistInput,
	FlashState
} from '../../../src/lib/cable/types.ts';
import { CONFIRMED, T0, off, padrao } from './harness.ts';

const cableMessages = (locale: string) => {
	const url = new URL(`../../../messages/${locale}.json`, import.meta.url);
	const messages = JSON.parse(readFileSync(url, 'utf8')) as Record<string, string>;
	return Object.fromEntries(Object.entries(messages).filter(([key]) => key.startsWith('cable_')));
};
const ptBR = cableMessages('pt-BR');
const enUS = cableMessages('en-US');

const ALL_CODES = [
	'a:b0',
	'a:b2',
	'a:-a1',
	'a:b1',
	'a:-a2',
	'b:pole-radius',
	'c:section-peak',
	'd:prefix-peak',
	'd:prefix-peak-full',
	'd:prefix-peak-extended',
	'e:output-audible',
	'e:output-extended',
	'e:output-full',
	'f:codec',
	'g:preamp',
	'k:kind-not-allowed',
	'd7:pk-boost-above-16k',
	'd7:boost-q',
	'd7:boost-above-20k'
] as const;

function flash(overrides: Partial<FlashState> = {}): FlashState {
	return {
		day: { date: null, count: 0 },
		total: 0,
		lastWriteAt: T0 - 10_000,
		session: 0,
		...overrides
	};
}

function context(overrides: Partial<ChecklistContext> = {}): ChecklistContext {
	return {
		nowMs: T0,
		flash: flash(),
		lastWrittenLevelDb: null,
		sessionWriteCount: 0,
		lastJournalStatus: null,
		...overrides
	};
}

function input(overrides: Partial<ChecklistInput> = {}): ChecklistInput {
	return {
		bands: padrao.eqBands,
		preampDb: padrao.preampDb,
		experimental: false,
		confirmations: CONFIRMED,
		...overrides
	};
}

function withKind(kind: 'HS' | 'LP' | 'HP'): Band[] {
	const band: Band =
		kind === 'HS'
			? { kind, freqHz: 8000, gainDb: -3, qFactor: 0.7 }
			: { kind, freqHz: kind === 'LP' ? 18000 : 30, qFactor: 0.7 };
	return [band, ...Array.from({ length: 9 }, off)];
}

describe('messages', () => {
	test('every gate reason code has a message key present in both locales', () => {
		expect(Object.keys(REASON_MESSAGE_KEYS).sort()).toEqual([...ALL_CODES].sort());
		for (const code of ALL_CODES) {
			const key = REASON_MESSAGE_KEYS[code];
			expect(ptBR[key], code).toBeTypeOf('string');
			expect(enUS[key], code).toBeTypeOf('string');
		}
		expect(ptBR.cable_reason_unknown).toBeTypeOf('string');
		for (const id of LAMP_IDS) expect(ptBR[`cable_lamp_${id}`]).toBeTypeOf('string');
	});

	test('both locales have the same cable_ keys', () => {
		expect(Object.keys(ptBR).sort()).toEqual(Object.keys(enUS).sort());
		for (const key of Object.keys(ptBR)) expect(key.startsWith('cable_')).toBe(true);
	});

	test('literal texts (plan §3.4 and T2.7)', () => {
		expect(LOUDNESS_WARNING_TEXT).toBe(
			'A nova curva pode soar mais alta. Abaixe o volume antes de gravar.'
		);
		expect(ptBR.cable_loudness_warning).toBe(LOUDNESS_WARNING_TEXT);
		expect(ptBR.cable_flash_notice).toBe(FLASH_NOTICE_TEXT);
		expect(EXPERIMENTAL_CONFIRMATION_TEXT).toBe(
			'Esta curva usa tipos que a página oficial nunca gravou. Os coeficientes estão dentro do envelope observado, mas o firmware nunca recebeu esses formatos.'
		);
		expect(ptBR.cable_experimental_text).toBe(EXPERIMENTAL_CONFIRMATION_TEXT);
		expect(ptBR.cable_confirm_volume).toBe('Abaixei o volume');
		expect(ptBR.cable_confirm_connection).toBe('Não vou desconectar durante a gravação (≈0,3 s)');
	});

	test('pt-BR copy has no em dash', () => {
		for (const value of Object.values(ptBR)) expect(value.includes('—')).toBe(false);
	});
});

describe('evaluateChecklist', () => {
	test('padrao with every confirmation passes; all lamps on; CRC 0x1970', () => {
		const result = evaluateChecklist(input(), context());
		expect(result.gateOk).toBe(true);
		expect(result.canWrite).toBe(true);
		expect(result.crc).toBe(0x1970);
		expect(result.lamps.map((lamp) => lamp.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'k']);
		expect(result.lamps.every((lamp) => lamp.state === 'ok')).toBe(true);
		expect(result.snapshot).not.toBeNull();
		expect(Object.isFrozen(result.snapshot)).toBe(true);
	});

	test('each confirmation is required', () => {
		for (const missing of ['volumeLowered', 'keepConnected'] as const) {
			const result = evaluateChecklist(
				input({ confirmations: { ...CONFIRMED, [missing]: false } }),
				context()
			);
			expect(result.canWrite, missing).toBe(false);
		}
	});

	test('a failing gate blocks the write and lights the right lamp', () => {
		const result = evaluateChecklist(input({ preampDb: 0 }), context());
		expect(result.gateOk).toBe(false);
		expect(result.canWrite).toBe(false);
		const g = result.lamps.find((lamp) => lamp.id === 'g');
		expect(g?.state).toBe('fail');
		expect(g?.reasons[0]?.messageKey).toBe('cable_reason_g_preamp');
		expect(g?.reasons[0]?.limit).toBe(-0.5);
	});

	test('a codec refusal leaves the analysis lamps unknown', () => {
		const result = evaluateChecklist(input({ bands: 'not bands' as unknown as Band[] }), context());
		expect(result.canWrite).toBe(false);
		expect(result.lamps.find((lamp) => lamp.id === 'f')?.state).toBe('fail');
		expect(result.lamps.find((lamp) => lamp.id === 'a')?.state).toBe('unknown');
		expect(result.crc).toBeNull();
	});

	test('d7 and k codes share lamp k', () => {
		expect(lampOf('d7:boost-q')).toBe('k');
		expect(lampOf('d7:pk-boost-above-16k')).toBe('k');
		expect(lampOf('k:kind-not-allowed')).toBe('k');
		expect(lampOf('e:output-full')).toBe('e');
	});

	test.each(['HS', 'LP', 'HP'] as const)('%s requires the experimental confirmation', (kind) => {
		const bands = withKind(kind);
		const without = evaluateChecklist(
			input({ bands, preampDb: -0.5, experimental: true }),
			context()
		);
		expect(without.experimentalRequired).toBe(true);
		expect(without.experimentalText).toBe(EXPERIMENTAL_CONFIRMATION_TEXT);
		expect(without.items.find((item) => item.id === 'experimental')).toEqual({
			id: 'experimental',
			required: true,
			satisfied: false
		});
		expect(without.canWrite).toBe(false);
		const confirmed = evaluateChecklist(
			input({
				bands,
				preampDb: -0.5,
				experimental: true,
				confirmations: { ...CONFIRMED, experimental: true }
			}),
			context()
		);
		expect(confirmed.items.find((item) => item.id === 'experimental')?.satisfied).toBe(true);
	});

	test('experimental kinds without experimental mode are refused by lamp k', () => {
		const result = evaluateChecklist(
			input({ bands: withKind('HS'), preampDb: -0.5, experimental: false }),
			context()
		);
		const k = result.lamps.find((lamp) => lamp.id === 'k');
		expect(k?.state).toBe('fail');
		expect(k?.reasons.map((reason) => reason.code)).toContain('k:kind-not-allowed');
		expect(result.canWrite).toBe(false);
	});

	test('padrao needs no experimental confirmation', () => {
		const result = evaluateChecklist(input(), context());
		expect(result.experimentalRequired).toBe(false);
		expect(result.experimentalText).toBe(EXPERIMENTAL_CONFIRMATION_TEXT);
	});

	test('a filter above 20 kHz requires the experimental confirmation, whatever its kind', () => {
		// A PK cut at 25 kHz: not an experimental kind, so the gate runs without the flag.
		const bands: Band[] = [
			{ kind: 'PK', freqHz: 25000, gainDb: -3, qFactor: 1 },
			...Array.from({ length: 9 }, off)
		];
		expect(hasUltrasonicBands(bands)).toBe(true);
		expect(hasExperimentalKinds(bands)).toBe(false);
		const without = evaluateChecklist(input({ bands, preampDb: -1 }), context());
		expect(without.gateOk).toBe(true);
		expect(without.experimentalRequired).toBe(true);
		expect(without.experimentalText).toBe(
			`${EXPERIMENTAL_CONFIRMATION_TEXT} ${ULTRASONIC_CONFIRMATION_TEXT}`
		);
		expect(without.items.find((item) => item.id === 'experimental')).toEqual({
			id: 'experimental',
			required: true,
			satisfied: false
		});
		expect(without.canWrite).toBe(false);
		const confirmed = evaluateChecklist(
			input({ bands, preampDb: -1, confirmations: { ...CONFIRMED, experimental: true } }),
			context()
		);
		expect(confirmed.canWrite).toBe(true);
		// 20 kHz itself is audible: nothing to confirm.
		const audible: Band[] = [
			{ kind: 'PK', freqHz: 20000, gainDb: -3, qFactor: 1 },
			...Array.from({ length: 9 }, off)
		];
		expect(evaluateChecklist(input({ bands: audible, preampDb: -1 }), context())).toMatchObject({
			experimentalRequired: false,
			canWrite: true
		});
		expect(ULTRASONIC_CONFIRMATION_TEXT).toBe(
			'Filtros acima de 20 kHz: confirme a gravação experimental.'
		);
	});

	test('loudness warning on the first write of the session', () => {
		const result = evaluateChecklist(input(), context({ sessionWriteCount: 0 }));
		expect(result.loudness.warn).toBe(true);
		expect(result.loudness.reasons).toContain('unknown-state');
		expect(result.loudness.text).toBe(LOUDNESS_WARNING_TEXT);
		// A warning is advisory: the confirmations still allow the write.
		expect(result.canWrite).toBe(true);
	});

	test('loudness warning on a +3 dB jump, not on +2.9 dB', () => {
		const level = levelDb(padrao.eqBands, padrao.preampDb);
		const jump = evaluateChecklist(
			input(),
			context({ lastWrittenLevelDb: level - 3, sessionWriteCount: 1, lastJournalStatus: 'ok' })
		);
		expect(jump.loudness.warn).toBe(true);
		expect(jump.loudness.reasons).toEqual(['jump']);
		const small = evaluateChecklist(
			input(),
			context({ lastWrittenLevelDb: level - 2.9, sessionWriteCount: 1, lastJournalStatus: 'ok' })
		);
		expect(small.loudness.warn).toBe(false);
	});

	test('loudness warning after an interrupted write', () => {
		const level = levelDb(NEUTRAL_BANDS, -0.5);
		const result = evaluateChecklist(
			input({ bands: NEUTRAL_BANDS, preampDb: -0.5 }),
			context({
				lastWrittenLevelDb: level,
				sessionWriteCount: 3,
				lastJournalStatus: 'interrupted'
			})
		);
		expect(result.loudness.reasons).toEqual(['unknown-state']);
	});

	test('2 s spacing: countdown and block', () => {
		const recent = flash({ lastWriteAt: T0 - 500 });
		const result = evaluateChecklist(input(), context({ flash: recent }));
		expect(result.spacing).toEqual({ ok: false, waitMs: 1500 });
		expect(result.items.find((item) => item.id === 'spacing')?.satisfied).toBe(false);
		expect(result.canWrite).toBe(false);
		const later = evaluateChecklist(input(), context({ nowMs: T0 + 1500, flash: recent }));
		expect(later.spacing.ok).toBe(true);
		expect(later.canWrite).toBe(true);
	});

	test('counters and the 50/day notice', () => {
		const today = localDateKey(T0);
		const at50 = evaluateChecklist(
			input(),
			context({ flash: flash({ day: { date: today, count: 50 }, total: 1234, session: 7 }) })
		);
		expect(at50.counters).toEqual({ session: 7, day: 50, total: 1234 });
		expect(at50.dailyNotice).toEqual({ show: true, text: FLASH_NOTICE_TEXT });
		expect(at50.canWrite).toBe(true);
		const at49 = evaluateChecklist(
			input(),
			context({ flash: flash({ day: { date: today, count: 49 } }) })
		);
		expect(at49.dailyNotice.show).toBe(false);
		const yesterday = evaluateChecklist(
			input(),
			context({ flash: flash({ day: { date: '2026-10-15', count: 80 } }) })
		);
		expect(yesterday.counters.day).toBe(0);
		expect(yesterday.dailyNotice.show).toBe(false);
	});
});
