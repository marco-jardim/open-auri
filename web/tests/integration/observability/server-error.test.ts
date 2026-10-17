// FXG.4 m1: hooks.server.ts `handleError` → logServerError. One PII-free JSON line per unexpected
// error (route id, status, error class; no message, stack or URL), SvelteKit's default body kept.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	errorClass,
	INTERNAL_ERROR_MESSAGE,
	logServerError,
	type ServerErrorLine
} from '#lib/server/observability/server-error.ts';

const SECRET_TOKEN = 'tok_9f8e7d6c5b4a3210';
const EMAIL = 'pessoa@example.com';
const URL_WITH_DATA = `https://example.org/api/v1/curves/abc123?token=${SECRET_TOKEN}`;

function input(kind: string, error: unknown, routeId: string | null = '/api/v1/curves/[id]') {
	return { kind, error, event: { route: { id: routeId } } };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('logServerError', () => {
	it('writes route id, status and error class only, and returns the default body', () => {
		const lines: ServerErrorLine[] = [];
		const error = new TypeError(`bad value ${EMAIL} at ${URL_WITH_DATA}`);
		const body = logServerError(input('unknown', error), (line) => lines.push(line));

		expect(body).toEqual({ message: 'Internal Error' });
		expect(INTERNAL_ERROR_MESSAGE).toBe('Internal Error');
		expect(lines).toEqual([
			{ event: 'server.error', route: '/api/v1/curves/[id]', status: 500, error: 'TypeError' }
		]);
		const text = JSON.stringify(lines);
		for (const leak of [EMAIL, SECRET_TOKEN, 'example.org', 'abc123', 'bad value', 'at ']) {
			expect(text).not.toContain(leak);
		}
		expect(text).not.toContain(error.stack ?? '<no stack>');
	});

	it('marks requests that matched no route', () => {
		const lines: ServerErrorLine[] = [];
		logServerError(input('unknown', new Error('x'), null), (line) => lines.push(line));
		expect(lines[0]?.route).toBe('(unmatched)');
	});

	it('never logs thrown non-Error values or data-bearing error names', () => {
		const lines: ServerErrorLine[] = [];
		const named = new Error('boom');
		named.name = `Leak ${EMAIL}`;
		for (const thrown of [`failed for ${EMAIL}`, { email: EMAIL }, null, 42, named]) {
			logServerError(input('unknown', thrown), (line) => lines.push(line));
		}
		expect(lines.map((line) => line.error)).toEqual([
			'string',
			'object',
			'null',
			'number',
			'Error'
		]);
		expect(JSON.stringify(lines)).not.toContain(EMAIL);
		expect(errorClass(new RangeError('x'))).toBe('RangeError');
	});

	it('leaves app, framework and validation errors to SvelteKit (no line, defaults kept)', () => {
		const write = vi.fn();
		expect(logServerError(input('app', { status: 404, message: 'Not found' }), write)).toBe(
			undefined
		);
		expect(logServerError(input('framework', { status: 405, message: 'x' }), write)).toBe(
			undefined
		);
		expect(logServerError(input('validation', { status: 400, message: 'x' }), write)).toBe(
			undefined
		);
		expect(write).not.toHaveBeenCalled();
	});

	it('writes one JSON line to console.error by default and survives a failing sink', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		logServerError(input('unknown', new SyntaxError(`token ${SECRET_TOKEN}`)));
		expect(error).toHaveBeenCalledTimes(1);
		expect(log).not.toHaveBeenCalled();
		const printed = String(error.mock.calls[0]?.[0]);
		expect(JSON.parse(printed)).toEqual({
			event: 'server.error',
			route: '/api/v1/curves/[id]',
			status: 500,
			error: 'SyntaxError'
		});
		expect(printed).not.toContain(SECRET_TOKEN);

		const body = logServerError(input('unknown', new Error('x')), () => {
			throw new Error('sink down');
		});
		expect(body).toEqual({ message: 'Internal Error' });
	});
});
