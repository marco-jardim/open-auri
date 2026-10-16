// S6: anonymous preference batches and the daily Bradley–Terry aggregation (plan §3.7 "S6",
// §3.8 LGPD art. 11, T4.9).
//
// Anonymity (Q4, de-anonymization):
// - A batch row holds only a random id, `receipt_hash` (SHA-256 hex of the browser's receipt),
//   the consent version and the UTC day. No user id, IP, IP hash, user agent or timestamp finer
//   than the day is stored; the routes never pass the session or the request to this module.
// - The batch id is random (no time component). Pairs are shuffled before the insert so their
//   order inside a batch does not reveal the order in which the person compared them.
// - `s6_pairs.id` is an INTEGER PRIMARY KEY (schema 0005, needed by the keyset pagination of
//   `listS6Pairs`): it reveals the relative insertion order of pairs, nothing about time beyond the
//   batch day. It is never published: the public JSON has only per-curve scores and counts.
// - The rate limit keys on the daily-salted IP hash in the Workers RateLimit binding only (not
//   persisted); no D1 quota is used, so no stored row could be ordered against the pairs.
// - Withdrawal is by receipt only and answers the same whether or not a batch existed.
//
// Bradley–Terry: Zermelo's MM iteration (Hunter 2004, Ann. Statist. 32(1):384–406; Wikipedia
// "Bradley–Terry model", eq. 3 and 4), ties = half a win each, geometric-mean normalization after
// every sweep, stop at max relative change < 1e-9 or 10 000 sweeps. The estimator exists only on
// a strongly connected comparison graph (Ford 1957): only the largest strongly connected component
// of the "beats" graph is scored.
import type { D1Database } from '@cloudflare/workers-types';
import { deleteS6BatchByReceipt, insertS6Batch, listS6Pairs } from '#lib/server/social/repo.ts';
import { S6_PAIRS_MAX, type S6Choice, type S6PairInput } from '#lib/server/social/types.ts';

/** Current consent text version; a batch with any other version is refused (CONSENT_REQUIRED). */
export const S6_CONSENT_VERSION = 's6-consent-v1';
/** Public object read by `GET /api/v1/s6/preferences`, written by the s6-aggregate job. */
export const S6_PREFERENCES_KEY = 's6/preferences.json';
/** Item ids accepted in a pair (same rule as the repository). */
export const S6_ITEM_PATTERN = /^[a-z0-9._-]{1,64}$/;
/** 32 random bytes as unpadded base64url (43 chars; the last one carries 2 bits, 4 zero bits). */
export const S6_RECEIPT_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export const BT_TOLERANCE = 1e-9;
export const BT_MAX_ITERATIONS = 10_000;

export { S6_PAIRS_MAX };

export interface S6SubmitBody {
	consentVersion: string;
	receipt: string;
	pairs: readonly S6PairInput[];
}

export type S6SubmitResult =
	{ ok: true } | { ok: false; code: 'consent-required' | 'invalid-input' | 'duplicate' };

function toHex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** SHA-256 hex of the receipt text (the only form of the receipt the server keeps). */
export async function receiptHash(receipt: string): Promise<string> {
	return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(receipt)));
}

export function isReceipt(value: unknown): value is string {
	return typeof value === 'string' && S6_RECEIPT_PATTERN.test(value);
}

/** UTC day YYYY-MM-DD: the finest time the batch keeps. */
export function s6Day(now: Date): string {
	return now.toISOString().slice(0, 10);
}

function randomIndex(bound: number): number {
	// Rejection sampling over 32-bit values: unbiased for any bound ≤ 2^32.
	const limit = Math.floor(0x1_0000_0000 / bound) * bound;
	const word = new Uint32Array(1);
	for (;;) {
		crypto.getRandomValues(word);
		const value = word[0] ?? 0;
		if (value < limit) return value % bound;
	}
}

/** Fisher–Yates with crypto randomness: the stored order says nothing about the session. */
function shuffled<T>(items: readonly T[]): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = randomIndex(i + 1);
		const current = out[i] as T;
		out[i] = out[j] as T;
		out[j] = current;
	}
	return out;
}

/**
 * Stores one anonymous batch: random id, receipt hash, consent version and day, plus the shuffled
 * pairs. `now` only contributes its UTC day.
 */
export async function submitBatch(
	db: D1Database,
	body: S6SubmitBody,
	now: Date
): Promise<S6SubmitResult> {
	if (body.consentVersion !== S6_CONSENT_VERSION) return { ok: false, code: 'consent-required' };
	if (!isReceipt(body.receipt)) return { ok: false, code: 'invalid-input' };
	const pairs = body.pairs.map((pair) => ({
		a: pair.a,
		b: pair.b,
		choice: pair.choice,
		levelMatched: pair.levelMatched
	}));
	const result = await insertS6Batch(db, {
		id: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
		receiptHash: await receiptHash(body.receipt),
		consentVer: S6_CONSENT_VERSION,
		day: s6Day(now),
		pairs: shuffled(pairs)
	});
	if (result.ok) return { ok: true };
	return { ok: false, code: result.code === 'duplicate' ? 'duplicate' : 'invalid-input' };
}

/**
 * Withdraws the batch of this receipt (pairs cascade). The boolean is for tests and the job only:
 * the route answers 204 either way, so it is not an existence oracle.
 */
export async function deleteBatch(db: D1Database, receipt: string): Promise<boolean> {
	if (!isReceipt(receipt)) return false;
	return deleteS6BatchByReceipt(db, await receiptHash(receipt));
}

// ---- Bradley–Terry ---------------------------------------------------------------------------

export interface BtPair {
	a: string;
	b: string;
	choice: S6Choice;
	/** Identical comparisons folded into one entry (positive integer, default 1). */
	weight?: number;
}

export interface BtOptions {
	/** Stop when the max relative change of a sweep is below this (default 1e-9). */
	tolerance?: number;
	/** Hard cap on sweeps (default 10 000). */
	maxIterations?: number;
}

export interface BtItem {
	curveId: string;
	/** Strength p_i, normalized so that the geometric mean of the scored items is 1. */
	score: number;
	/** Comparisons of this item inside the scored component (ties included). */
	comparisons: number;
}

export interface BtResult {
	/** Score descending, then curveId ascending (code-unit order). */
	items: BtItem[];
	/** Items outside the largest strongly connected component, ascending. */
	excluded: string[];
	iterations: number;
	converged: boolean;
}

function compareIds(x: string, y: string): number {
	return x < y ? -1 : x > y ? 1 : 0;
}

/** Tarjan's algorithm, iterative (no recursion depth limit). Components have ascending indices. */
function stronglyConnected(adjacency: readonly (readonly number[])[]): number[][] {
	const size = adjacency.length;
	const index = new Array<number>(size).fill(-1);
	const low = new Array<number>(size).fill(0);
	const onStack = new Array<boolean>(size).fill(false);
	const stack: number[] = [];
	const components: number[][] = [];
	let counter = 0;
	const visit = (v: number) => {
		index[v] = counter;
		low[v] = counter;
		counter += 1;
		stack.push(v);
		onStack[v] = true;
	};
	for (let root = 0; root < size; root++) {
		if (index[root] !== -1) continue;
		visit(root);
		const work: { v: number; next: number }[] = [{ v: root, next: 0 }];
		while (work.length > 0) {
			const frame = work[work.length - 1] as { v: number; next: number };
			const edges = adjacency[frame.v] ?? [];
			if (frame.next < edges.length) {
				const w = edges[frame.next] as number;
				frame.next += 1;
				if (index[w] === -1) {
					visit(w);
					work.push({ v: w, next: 0 });
				} else if (onStack[w]) {
					low[frame.v] = Math.min(low[frame.v] as number, index[w] as number);
				}
				continue;
			}
			work.pop();
			const parent = work[work.length - 1];
			if (parent) low[parent.v] = Math.min(low[parent.v] as number, low[frame.v] as number);
			if (low[frame.v] === index[frame.v]) {
				const component: number[] = [];
				let w: number | undefined;
				do {
					w = stack.pop();
					if (w === undefined) break;
					onStack[w] = false;
					component.push(w);
				} while (w !== frame.v);
				components.push(component.sort((x, y) => x - y));
			}
		}
	}
	return components;
}

function positiveInteger(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value < 1) throw new RangeError('s6: invalid count');
	return value;
}

/**
 * Bradley–Terry strengths by Zermelo's MM iteration `p_i ← W_i / Σ_{j≠i} n_ij / (p_i + p_j)`.
 * Pure and deterministic: the result does not depend on the order of `pairs` (counts are
 * aggregated first and every sum runs in item order). Pairs with `a === b` are ignored.
 */
export function bradleyTerry(pairs: Iterable<BtPair>, options: BtOptions = {}): BtResult {
	const tolerance = options.tolerance ?? BT_TOLERANCE;
	if (!(tolerance > 0)) throw new RangeError('s6: invalid tolerance');
	const maxIterations = positiveInteger(options.maxIterations, BT_MAX_ITERATIONS);

	const list = [...pairs].filter((pair) => pair.a !== pair.b);
	const ids = [...new Set(list.flatMap((pair) => [pair.a, pair.b]))].sort(compareIds);
	const position = new Map(ids.map((id, i) => [id, i]));
	// cells[i].get(j) = { n: comparisons i–j, wins: wins of i over j (ties count half) }.
	const cells = ids.map(() => new Map<number, { n: number; wins: number }>());
	const add = (i: number, j: number, n: number, wins: number) => {
		const row = cells[i] as Map<number, { n: number; wins: number }>;
		const cell = row.get(j) ?? { n: 0, wins: 0 };
		cell.n += n;
		cell.wins += wins;
		row.set(j, cell);
	};
	for (const pair of list) {
		const weight = positiveInteger(pair.weight, 1);
		const a = position.get(pair.a) as number;
		const b = position.get(pair.b) as number;
		const share = pair.choice === 'a' ? 1 : pair.choice === 'tie' ? 0.5 : 0;
		add(a, b, weight, weight * share);
		add(b, a, weight, weight * (1 - share));
	}

	// "Beats" graph: i → j when i won (or tied) at least once against j.
	const adjacency = cells.map((row) =>
		[...row.entries()]
			.filter(([, cell]) => cell.wins > 0)
			.map(([j]) => j)
			.sort((x, y) => x - y)
	);
	const largest = stronglyConnected(adjacency)
		.filter((component) => component.length >= 2)
		.sort((x, y) => y.length - x.length || (x[0] as number) - (y[0] as number))[0];
	const members = largest ?? [];
	const inside = new Set(members);
	const excluded = ids.filter((_, i) => !inside.has(i));
	if (members.length === 0) return { items: [], excluded, iterations: 0, converged: true };

	const local = new Map(members.map((global, i) => [global, i]));
	const wins: number[] = [];
	const counts: number[] = [];
	const edges: { j: number; n: number }[][] = [];
	for (const global of members) {
		let w = 0;
		let n = 0;
		const row: { j: number; n: number }[] = [];
		const cellsOf = cells[global] as Map<number, { n: number; wins: number }>;
		for (const [other, cell] of [...cellsOf.entries()].sort((x, y) => x[0] - y[0])) {
			const j = local.get(other);
			if (j === undefined) continue;
			w += cell.wins;
			n += cell.n;
			row.push({ j, n: cell.n });
		}
		wins.push(w);
		counts.push(n);
		edges.push(row);
	}

	const size = members.length;
	let p = new Array<number>(size).fill(1);
	let iterations = 0;
	let converged = false;
	while (iterations < maxIterations) {
		iterations += 1;
		const next = new Array<number>(size);
		let logSum = 0;
		for (let i = 0; i < size; i++) {
			const pi = p[i] as number;
			let denominator = 0;
			for (const { j, n } of edges[i] ?? []) denominator += n / (pi + (p[j] as number));
			const value = (wins[i] as number) / denominator;
			next[i] = value;
			logSum += Math.log(value);
		}
		const mean = Math.exp(logSum / size);
		let change = 0;
		for (let i = 0; i < size; i++) {
			const value = (next[i] as number) / mean;
			next[i] = value;
			const previous = p[i] as number;
			change = Math.max(change, Math.abs(value - previous) / previous);
		}
		p = next;
		if (change < tolerance) {
			converged = true;
			break;
		}
	}

	const items = members
		.map((global, i) => ({
			curveId: ids[global] as string,
			score: p[i] as number,
			comparisons: counts[i] as number
		}))
		.sort((x, y) => y.score - x.score || compareIds(x.curveId, y.curveId));
	return { items, excluded, iterations, converged };
}

// ---- Aggregation -----------------------------------------------------------------------------

export interface S6Preferences {
	generatedAt: string;
	consentVersion: string;
	items: BtItem[];
	/** Pairs read from the database and fed to the estimator. */
	pairs: number;
}

/** Page size of the aggregation read (the repository caps it at 5000). */
export const S6_AGGREGATE_PAGE = 5000;

/** Published scores keep 6 decimals: stable output, no false precision. */
function rounded(value: number): number {
	return Math.round(value * 1e6) / 1e6;
}

/**
 * Reads every stored pair (keyset pages of `listS6Pairs`), folds identical comparisons and runs
 * Bradley–Terry. The result is the public JSON: per-curve scores and counts only (no day, no batch,
 * no pair ids).
 */
export async function aggregate(
	db: D1Database,
	now: Date,
	options: BtOptions = {}
): Promise<S6Preferences> {
	const folded = new Map<string, BtPair & { weight: number }>();
	let total = 0;
	let afterId = 0;
	for (;;) {
		const page = await listS6Pairs(db, { afterId, limit: S6_AGGREGATE_PAGE });
		for (const pair of page) {
			total += 1;
			const key = `${pair.a}\n${pair.b}\n${pair.choice}`;
			const entry = folded.get(key);
			if (entry) entry.weight += 1;
			else folded.set(key, { a: pair.a, b: pair.b, choice: pair.choice, weight: 1 });
		}
		const last = page[page.length - 1];
		if (!last || page.length < S6_AGGREGATE_PAGE) break;
		afterId = last.id;
	}
	const result = bradleyTerry(folded.values(), options);
	return {
		generatedAt: now.toISOString(),
		consentVersion: S6_CONSENT_VERSION,
		items: result.items.map((item) => ({ ...item, score: rounded(item.score) })),
		pairs: total
	};
}
