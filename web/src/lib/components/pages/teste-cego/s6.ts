// S6 submission from the blind test (T4.16): the exact anonymous batch, its random receipt and the
// local list of receipts used to withdraw a batch later. Item ids are the curve ids (`curveId`:
// lowercase base32 of SHA-256 of the S1 bytes), so the aggregation compares curves, not labels.
// The constants duplicate the server's (`#lib/server/social/s6.ts` cannot be imported in the
// browser); `tests/unit/pages/teste-cego/s6-batch.svelte.test.ts` checks them against its source.
import { curveId, encodeS1 } from 'open-auri/share';
import type { Candidate, Session } from './experiment.ts';

export const S6_CONSENT_VERSION = 's6-consent-v1';
export const S6_TURNSTILE_ACTION = 's6-submit';
export const S6_ITEM_PATTERN = /^[a-z0-9._-]{1,64}$/;
export const S6_RECEIPT_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
export const S6_PAIRS_MAX = 100;
export const S6_RECEIPTS_KEY = 'oa.s6.receipts';
export const S6_RECEIPTS_MAX = 50;

export type S6Choice = 'a' | 'b' | 'tie';
export interface S6Pair {
	a: string;
	b: string;
	choice: S6Choice;
	levelMatched: boolean;
}
export interface S6Batch {
	consentVersion: string;
	receipt: string;
	pairs: S6Pair[];
}
export interface S6Receipt {
	receipt: string;
	/** UTC day of the submission (the server keeps only the day too). */
	day: string;
	pairs: number;
}
export interface ReceiptStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

function base64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** 32 fresh random bytes as unpadded base64url (43 characters). */
export function newReceipt(
	random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)
): string {
	return base64Url(random(new Uint8Array(new ArrayBuffer(32))));
}

/** The S6 item id of a candidate, or null when its curve has no exact S1 form. */
export async function itemIdOf(
	value: Pick<Candidate, 'bands' | 'preampDb'>
): Promise<string | null> {
	let id: string;
	try {
		id = await curveId(encodeS1({ bands: value.bands, preampDb: value.preampDb }));
	} catch (error) {
		void error; // a curve off the S1 grid (some variations) cannot be named: it is left out
		return null;
	}
	return S6_ITEM_PATTERN.test(id) ? id : null;
}

/**
 * One pair per two positions of each completed round. The higher rating wins, equal ratings tie.
 * Pairs whose curves cannot be named, or that name the same curve twice, are left out.
 */
export async function buildPairs(session: Session | null, levelMatched = true): Promise<S6Pair[]> {
	if (!session) return [];
	const ids = new Map<string, string | null>();
	for (const candidate of session.candidates) ids.set(candidate.id, await itemIdOf(candidate));
	const pairs: S6Pair[] = [];
	for (const round of session.completed) {
		for (let i = 0; i < round.order.length; i++) {
			for (let j = i + 1; j < round.order.length; j++) {
				const a = ids.get(round.order[i]!) ?? null;
				const b = ids.get(round.order[j]!) ?? null;
				const ra = round.ratings[i];
				const rb = round.ratings[j];
				if (a === null || b === null || a === b || ra === undefined || rb === undefined) continue;
				pairs.push({ a, b, choice: ra > rb ? 'a' : ra < rb ? 'b' : 'tie', levelMatched });
			}
		}
	}
	return pairs.slice(0, S6_PAIRS_MAX);
}

/** The exact request body, in the key order shown in the preview. */
export function buildBatch(receipt: string, pairs: readonly S6Pair[]): S6Batch {
	return {
		consentVersion: S6_CONSENT_VERSION,
		receipt,
		pairs: pairs.map((pair) => ({
			a: pair.a,
			b: pair.b,
			choice: pair.choice,
			levelMatched: pair.levelMatched
		}))
	};
}

export function s6Day(now: Date = new Date()): string {
	return now.toISOString().slice(0, 10);
}

export function defaultReceiptStorage(): ReceiptStorage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch (error) {
		console.warn(JSON.stringify({ event: 's6.receipts.storage', error: (error as Error).name }));
		return null;
	}
}

function isReceiptRecord(value: unknown): value is S6Receipt {
	if (typeof value !== 'object' || value === null) return false;
	const { receipt, day, pairs } = value as Record<string, unknown>;
	return (
		typeof receipt === 'string' &&
		S6_RECEIPT_PATTERN.test(receipt) &&
		typeof day === 'string' &&
		/^\d{4}-\d{2}-\d{2}$/.test(day) &&
		typeof pairs === 'number' &&
		Number.isInteger(pairs) &&
		pairs >= 0
	);
}

export function readReceipts(storage: ReceiptStorage): S6Receipt[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(storage.getItem(S6_RECEIPTS_KEY) ?? '[]');
	} catch (error) {
		console.warn(JSON.stringify({ event: 's6.receipts.read', error: (error as Error).name }));
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.filter(isReceiptRecord).map(({ receipt, day, pairs }) => ({ receipt, day, pairs }));
}

function writeReceipts(storage: ReceiptStorage, list: readonly S6Receipt[]): S6Receipt[] {
	const kept = list.slice(-S6_RECEIPTS_MAX);
	try {
		storage.setItem(S6_RECEIPTS_KEY, JSON.stringify(kept));
	} catch (error) {
		console.warn(JSON.stringify({ event: 's6.receipts.write', error: (error as Error).name }));
	}
	return readReceipts(storage);
}

export function addReceipt(storage: ReceiptStorage, record: S6Receipt): S6Receipt[] {
	const list = readReceipts(storage).filter((item) => item.receipt !== record.receipt);
	return writeReceipts(storage, [...list, record]);
}

export function removeReceipt(storage: ReceiptStorage, receipt: string): S6Receipt[] {
	return writeReceipts(
		storage,
		readReceipts(storage).filter((item) => item.receipt !== receipt)
	);
}
