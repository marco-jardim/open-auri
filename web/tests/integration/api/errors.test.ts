// T4.1b: stable error contract of /api/v1 (errors.ts).
import { describe, expect, it } from 'vitest';
import {
	API_ERROR_CODES,
	API_ERROR_STATUS,
	ApiError,
	apiError,
	apiErrorFrom
} from '#lib/server/api/index.ts';
import { expectErrorResponse } from './helpers.ts';

describe('API_ERROR_CODES', () => {
	it('is a unique, upper-snake list with a status for every code', () => {
		expect(new Set(API_ERROR_CODES).size).toBe(API_ERROR_CODES.length);
		for (const code of API_ERROR_CODES) {
			expect(code).toMatch(/^[A-Z][A-Z_]*$/);
			expect(API_ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
		}
		expect(Object.keys(API_ERROR_STATUS).sort()).toEqual([...API_ERROR_CODES].sort());
	});
});

describe('apiError', () => {
	it('renders every code as { error: { code } } with no-store', async () => {
		for (const code of API_ERROR_CODES) {
			const body = await expectErrorResponse(
				apiError(API_ERROR_STATUS[code], code),
				API_ERROR_STATUS[code],
				code
			);
			expect(body).toEqual({ error: { code } });
		}
	});

	it('includes details only when given and merges extra headers', async () => {
		const response = apiError(
			429,
			'RATE_LIMITED',
			{ scope: 'write' },
			{
				'retry-after': '60',
				'cache-control': 'public, max-age=60'
			}
		);
		expect(response.headers.get('retry-after')).toBe('60');
		const body = await expectErrorResponse(response, 429, 'RATE_LIMITED');
		expect(body.error.details).toEqual({ scope: 'write' });
	});
});

describe('ApiError', () => {
	it('carries status, code, details, headers and cause', () => {
		const cause = new Error('inner');
		const error = new ApiError(
			409,
			'CONFLICT',
			{ field: 'name' },
			{
				headers: { 'x-a': '1' },
				cause
			}
		);
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe('ApiError');
		expect(error.message).toBe('CONFLICT');
		expect(error.status).toBe(409);
		expect(error.code).toBe('CONFLICT');
		expect(error.details).toEqual({ field: 'name' });
		expect(error.headers).toEqual({ 'x-a': '1' });
		expect(error.cause).toBe(cause);
	});

	it('omits details and headers by default; apiErrorFrom renders it', async () => {
		const error = new ApiError(403, 'FORBIDDEN');
		expect('details' in error).toBe(false);
		expect(error.headers).toEqual({});
		expect(error.cause).toBeUndefined();
		const body = await expectErrorResponse(apiErrorFrom(error), 403, 'FORBIDDEN');
		expect(body).toEqual({ error: { code: 'FORBIDDEN' } });

		const withHeaders = apiErrorFrom(
			new ApiError(429, 'RATE_LIMITED', undefined, { headers: { 'retry-after': '5' } })
		);
		expect(withHeaders.headers.get('retry-after')).toBe('5');
	});
});
