import { describe, expect, it, vi } from 'vitest';
import {
	assertMessageMetadata,
	buildIdempotencyKey,
	EmailError,
	type EmailMessage,
	type EmailProvider
} from '#lib/server/email/provider.ts';
import {
	deriveSuppressionKey,
	hashAddress,
	normalizeAddress,
	withSuppression
} from '#lib/server/email/suppression.ts';
import { fromBase64, timingSafeEqual } from '#lib/server/email/bytes.ts';

const SECRET = 'unit-test-only-better-auth-secret-0000000000';
const ADDRESS = 'Pessoa.Teste@Example.com';

const message: EmailMessage = {
	to: ADDRESS,
	subject: 's',
	html: '<p>h</p>',
	text: 't',
	idempotencyKey: 'k:1'
};

describe('address hashing', () => {
	it('normalizes case, surrounding space and Unicode form', () => {
		expect(normalizeAddress('  Pessoa.Teste@Example.COM ')).toBe('pessoa.teste@example.com');
		expect(normalizeAddress('jose\u0301@example.com')).toBe(normalizeAddress('josé@example.com'));
	});

	it('hashes normalized addresses to a stable hex digest without the address', async () => {
		const key = await deriveSuppressionKey(SECRET);
		const hash = await hashAddress(key, ADDRESS);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(await hashAddress(key, ' pessoa.teste@EXAMPLE.com')).toBe(hash);
		expect(await hashAddress(key, 'outra@example.com')).not.toBe(hash);
	});

	it('depends on the secret', async () => {
		const a = await hashAddress(await deriveSuppressionKey(SECRET), ADDRESS);
		const b = await hashAddress(await deriveSuppressionKey(`${SECRET}-rotated`), ADDRESS);
		expect(a).not.toBe(b);
	});

	it('refuses a short secret', async () => {
		await expect(deriveSuppressionKey('short')).rejects.toBeInstanceOf(EmailError);
	});
});

describe('withSuppression', () => {
	function fakeProvider() {
		const send = vi.fn<EmailProvider['send']>(async () => ({ id: 'msg' }));
		return { provider: { send }, send };
	}

	it('refuses suppressed recipients before reaching the provider', async () => {
		const { provider, send } = fakeProvider();
		const guarded = withSuppression(provider, { isSuppressed: async () => true });
		const error = await guarded.send(message).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(EmailError);
		expect(error instanceof EmailError && error.kind).toBe('suppressed');
		expect(error instanceof EmailError && error.message).not.toContain('Pessoa');
		expect(send).not.toHaveBeenCalled();
	});

	it('passes other recipients through', async () => {
		const { provider, send } = fakeProvider();
		const guarded = withSuppression(provider, { isSuppressed: async () => false });
		await expect(guarded.send(message)).resolves.toEqual({ id: 'msg' });
		expect(send).toHaveBeenCalledWith(message);
	});
});

describe('provider helpers', () => {
	it('builds deterministic idempotency keys that reveal nothing', async () => {
		const key = await buildIdempotencyKey('verify-email', 'user_1', ADDRESS);
		expect(key).toMatch(/^verify-email:[0-9a-f]{64}$/);
		expect(key).not.toContain('Pessoa');
		expect(await buildIdempotencyKey('verify-email', 'user_1', ADDRESS)).toBe(key);
		expect(await buildIdempotencyKey('verify-email', 'user_2', ADDRESS)).not.toBe(key);
		expect(await buildIdempotencyKey('reset-password', 'user_1', ADDRESS)).not.toBe(key);
		expect(() => assertMessageMetadata({ ...message, idempotencyKey: key })).not.toThrow();
		await expect(buildIdempotencyKey('Bad Scope', 'x')).rejects.toBeInstanceOf(EmailError);
	});

	it('keeps only safe vendor codes in errors', () => {
		const safe = new EmailError('invalid', 'fixed reason', {
			status: 422,
			code: 'validation_error'
		});
		expect(safe.code).toBe('validation_error');
		expect(safe.message).toBe('email invalid: fixed reason (422 validation_error)');
		const unsafe = new EmailError('invalid', 'fixed reason', { code: 'Invalid to: a@b.c' });
		expect(unsafe.code).toBeNull();
		expect(unsafe.message).toBe('email invalid: fixed reason');
	});

	it('decodes base64 strictly and compares bytes', () => {
		expect(Array.from(fromBase64('AQID') ?? [])).toEqual([1, 2, 3]);
		expect(fromBase64('')).toBeNull();
		expect(fromBase64('###')).toBeNull();
		expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
		expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
		expect(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
	});
});
