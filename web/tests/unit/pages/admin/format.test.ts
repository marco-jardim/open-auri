import { describe, expect, test } from 'vitest';
import {
	detailText,
	formatWhen,
	minutesLeft,
	pageHref,
	userStatus
} from '#lib/components/admin/format.ts';

describe('admin format helpers', () => {
	const now = Date.UTC(2026, 9, 16, 12, 0, 0);

	test('userStatus distinguishes active, permanent, timed and expired bans', () => {
		expect(userStatus({ banned: false, banExpires: null }, now)).toBe('active');
		expect(userStatus({ banned: true, banExpires: null }, now)).toBe('banned');
		expect(userStatus({ banned: true, banExpires: 'garbage' }, now)).toBe('banned');
		expect(userStatus({ banned: true, banExpires: new Date(now + 1000).toISOString() }, now)).toBe(
			'banned_until'
		);
		expect(userStatus({ banned: true, banExpires: new Date(now - 1000).toISOString() }, now)).toBe(
			'ban_expired'
		);
	});

	test('formatWhen renders UTC in the page locale and tolerates bad input', () => {
		const ms = Date.UTC(2026, 9, 16, 14, 5);
		expect(formatWhen(ms, 'pt-BR')).toMatch(/^16\/10\/2026,? 14:05 UTC$/);
		expect(formatWhen(ms, 'en-US')).toMatch(/^10\/16\/2026,? 14:05 UTC$/);
		expect(formatWhen(null, 'pt-BR')).toBe('-');
		expect(formatWhen('nope', 'pt-BR')).toBe('-');
	});

	test('detailText is flat text', () => {
		expect(detailText(null)).toBe('');
		expect(detailText({ reason: '<b>spam</b>', days: 7, extra: null })).toBe(
			'reason=<b>spam</b> · days=7 · extra=null'
		);
	});

	test('pageHref keeps filters and drops page 1', () => {
		const search = new URLSearchParams('target=u1&page=3');
		expect(pageHref('/admin/auditoria', search, 1)).toBe('/admin/auditoria?target=u1');
		expect(pageHref('/admin/auditoria', search, 4)).toBe('/admin/auditoria?target=u1&page=4');
		expect(pageHref('/admin/auditoria', new URLSearchParams(), 1)).toBe('/admin/auditoria');
	});

	test('minutesLeft rounds up and never goes negative', () => {
		expect(minutesLeft(now + 61_000, now)).toBe(2);
		expect(minutesLeft(now - 5_000, now)).toBe(0);
	});
});
