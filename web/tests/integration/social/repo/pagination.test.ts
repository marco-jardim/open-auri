// Keyset pagination (T4.1): opaque base64url cursors validated on decode, page-size clamp, stable
// order with id tie-break, no duplicates or gaps when rows are added between pages.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
	clampPageSize,
	decodeCursor,
	encodeCursor,
	listOwnLineages,
	listOwnActivity,
	listPublicFeed,
	recordActivity
} from '#lib/server/social/repo.ts';
import { SocialRepoError } from '#lib/server/social/types.ts';
import { publish, seedUser } from './helpers.ts';

function invalid(cursor: string, shape: ('string' | 'number')[] = ['number', 'string']) {
	try {
		decodeCursor(cursor, shape);
	} catch (error) {
		return error instanceof SocialRepoError ? error.code : 'other';
	}
	return 'accepted';
}

function b64url(text: string): string {
	return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('cursors', () => {
	it('round-trips and is opaque base64url', () => {
		const cursor = encodeCursor([1760000000000, 'lin-ção/+?']);
		expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(decodeCursor(cursor, ['number', 'string'])).toEqual([1760000000000, 'lin-ção/+?']);
		expect(decodeCursor(null, ['number'])).toBeNull();
		expect(decodeCursor('', ['number'])).toBeNull();
		expect(decodeCursor(undefined, ['number'])).toBeNull();
	});

	it('rejects anything that is not a cursor of the expected shape', () => {
		expect(invalid('not a cursor!')).toBe('invalid-cursor');
		expect(invalid('x'.repeat(600))).toBe('invalid-cursor');
		expect(invalid(b64url('{"a":1}'))).toBe('invalid-cursor');
		expect(invalid(b64url('[1]'))).toBe('invalid-cursor');
		expect(invalid(b64url('["1","a"]'))).toBe('invalid-cursor');
		expect(invalid(b64url('[1.5,"a"]'))).toBe('invalid-cursor');
		expect(invalid(b64url('[9007199254740993,"a"]'))).toBe('invalid-cursor');
		expect(invalid(b64url(`[1,"${'a'.repeat(200)}"]`))).toBe('invalid-cursor');
		expect(invalid(b64url('[1,"a"'))).toBe('invalid-cursor');
		expect(invalid('A')).toBe('invalid-cursor');
		expect(invalid(b64url('[1,"a"]'))).toBe('accepted');
	});

	it('list functions refuse a forged cursor', async () => {
		await expect(listPublicFeed(env.DB, { cursor: b64url('["x"]') })).rejects.toMatchObject({
			code: 'invalid-cursor'
		});
	});

	it('clamps the page size', () => {
		expect(clampPageSize(undefined)).toBe(20);
		expect(clampPageSize(null)).toBe(20);
		expect(clampPageSize(Number.NaN)).toBe(20);
		expect(clampPageSize(0)).toBe(1);
		expect(clampPageSize(-5)).toBe(1);
		expect(clampPageSize(2.7)).toBe(2);
		expect(clampPageSize(10_000)).toBe(100);
	});
});

describe('stable keyset order', () => {
	it('rows with the same timestamp are ordered by id and never repeated or skipped', async () => {
		const owner = await seedUser();
		const at = Date.now();
		const created: string[] = [];
		for (let index = 0; index < 5; index += 1) {
			created.push((await publish(owner.id, { now: at })).lineageId);
		}
		const expected = [...created].sort().reverse();
		const seen: string[] = [];
		let cursor: string | null = null;
		let first = true;
		do {
			const page = await listOwnLineages(env.DB, owner.id, { cursor, limit: 2 });
			expect(page.items.length).toBeLessThanOrEqual(2);
			seen.push(...page.items.map((item) => item.id));
			cursor = page.nextCursor;
			if (first) {
				// A newer row added between pages does not shift the following pages.
				await publish(owner.id, { now: at + 1000 });
				first = false;
			}
		} while (cursor);
		expect(seen).toEqual(expected);
	});

	it('the public feed walks every row once, newest first', async () => {
		const owner = await seedUser();
		const base = Date.now();
		const created: string[] = [];
		for (let index = 0; index < 4; index += 1) {
			created.push((await publish(owner.id, { now: base + index })).lineageId);
		}
		const seen: string[] = [];
		let cursor: string | null = null;
		for (let guard = 0; guard < 1000; guard += 1) {
			const page = await listPublicFeed(env.DB, { cursor, limit: 3 });
			seen.push(...page.items.map((item) => item.id));
			if (!page.nextCursor) break;
			cursor = page.nextCursor;
		}
		const mine = seen.filter((id) => created.includes(id));
		expect(mine).toEqual([...created].reverse());
		expect(new Set(seen).size).toBe(seen.length);
	});

	it('the activity history pages on (last_at, lineage, kind)', async () => {
		const user = await seedUser();
		const owner = await seedUser();
		const at = Date.now();
		const a = await publish(owner.id);
		const b = await publish(owner.id);
		for (const lineage of [a, b]) {
			await recordActivity(env.DB, user.id, lineage.lineageId, 'previewed', at);
			await recordActivity(env.DB, user.id, lineage.lineageId, 'installed', at);
		}
		const seen: string[] = [];
		let cursor: string | null = null;
		do {
			const page = await listOwnActivity(env.DB, user.id, { cursor, limit: 1 });
			seen.push(...page.items.map((item) => `${item.lineageId}:${item.kind}`));
			cursor = page.nextCursor;
		} while (cursor);
		const [high, low] = [a.lineageId, b.lineageId].sort().reverse();
		expect(seen).toEqual([
			`${high}:previewed`,
			`${high}:installed`,
			`${low}:previewed`,
			`${low}:installed`
		]);
	});
});
