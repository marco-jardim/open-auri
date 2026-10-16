import { describe, expect, it } from 'vitest';
import { readEmailTokenPayload, emailLocaleFromRequest } from '#lib/server/auth/emails.ts';
import { checkUser, checkVerified } from '#lib/server/auth/guards.ts';
import {
	hasTwoFactorMarker,
	isAdminEffective,
	isFreshSession
} from '#lib/server/auth/session-policy.ts';

describe('session policy', () => {
	const now = Date.UTC(2026, 9, 16, 12);
	const admin = { role: 'admin', twoFactorEnabled: true, banned: false };

	it('requires the 2FA marker for admins only when ADMIN_2FA_REQUIRED', () => {
		const plain = { createdAt: new Date(now), twoFactorVerifiedAt: null };
		const marked = { createdAt: new Date(now), twoFactorVerifiedAt: new Date(now) };
		expect(hasTwoFactorMarker(plain)).toBe(false);
		expect(hasTwoFactorMarker(marked)).toBe(true);
		expect(isAdminEffective(plain, admin, { flags: { admin2faRequired: true } })).toBe(false);
		expect(isAdminEffective(marked, admin, { flags: { admin2faRequired: true } })).toBe(true);
		expect(isAdminEffective(plain, admin, { flags: { admin2faRequired: false } })).toBe(true);
	});

	it('measures freshness from creation or the last 2FA verification', () => {
		expect(isFreshSession({ createdAt: now - 599_000 }, 600_000, now)).toBe(true);
		expect(isFreshSession({ createdAt: now - 600_000 }, 600_000, now)).toBe(false);
		expect(isFreshSession({ createdAt: now + 60_000 }, 600_000, now)).toBe(false);
	});

	it('checkUser/checkVerified need a matching session', () => {
		expect(checkUser({ user: null, session: null })).toMatchObject({ status: 401 });
		expect(checkVerified({ user: null, session: null })).toMatchObject({ status: 401 });
	});
});

describe('auth e-mail helpers', () => {
	function jwt(payload: object): string {
		const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
		return `${encode({ alg: 'HS256' })}.${encode(payload)}.sig`;
	}

	it('reads the change-email fields of a verification token', () => {
		expect(readEmailTokenPayload(jwt({ email: 'a@x.example', updateTo: 'b@x.example' }))).toEqual({
			email: 'a@x.example',
			updateTo: 'b@x.example'
		});
		expect(readEmailTokenPayload(jwt({ email: 'a@x.example' }))).toEqual({ email: 'a@x.example' });
		expect(readEmailTokenPayload('garbage')).toEqual({});
	});

	it('picks the e-mail locale from the oa_lang cookie, then Accept-Language', () => {
		const request = (headers: Record<string, string>) =>
			new Request('https://x.example/', { headers });
		expect(emailLocaleFromRequest(request({ cookie: 'a=1; oa_lang=en-US' }))).toBe('en-US');
		expect(emailLocaleFromRequest(request({ 'accept-language': 'en-GB,en;q=0.9' }))).toBe('en-US');
		expect(emailLocaleFromRequest(request({ 'accept-language': 'pt-BR' }))).toBe('pt-BR');
		expect(emailLocaleFromRequest(undefined)).toBe('pt-BR');
	});
});
