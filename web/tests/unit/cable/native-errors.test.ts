import { describe, expect, test } from 'vitest';
import {
	NATIVE_ERROR_CODES,
	NATIVE_ERROR_NAMES,
	UNKNOWN_NATIVE_ERROR_NAME,
	callNative,
	isNativeErrorCode,
	nativeError,
	nativeErrorCode,
	type NativeErrorCode
} from '#lib/cable/native/errors.ts';

/** What Capacitor rejects with: `CapacitorException` (an Error with `code` and maybe `data`). */
class FakeCapacitorException extends Error {
	readonly code: string | undefined;
	readonly data: Record<string, unknown> | undefined;

	constructor(message: string, code?: string, data?: Record<string, unknown>) {
		super(message);
		this.code = code;
		this.data = data;
	}
}

/** Plan Anexo C, written out independently of the implementation's table. */
const ANEXO_C: ReadonlyArray<[NativeErrorCode, string]> = [
	['USB_BAD_ARGS', 'TypeError'],
	['USB_NOT_FOUND', 'NotFoundError'],
	['USB_NOT_OPEN', 'InvalidStateError'],
	['USB_BUSY', 'InvalidStateError'],
	['USB_PERMISSION_DENIED', 'NotAllowedError'],
	['USB_GUARD_REJECTED', 'NotAllowedError'],
	['USB_TRANSFER_FAILED', 'NotAllowedError'],
	['USB_TIMEOUT', 'NotAllowedError'],
	['USB_DETACHED', 'NotAllowedError'],
	['USB_ORIGIN', 'SecurityError'],
	['USB_NO_HOST', 'NotSupportedError']
];

describe('Anexo C mapping', () => {
	test('covers every native code exactly once', () => {
		expect(ANEXO_C.map(([code]) => code)).toEqual([...NATIVE_ERROR_CODES]);
		expect(Object.keys(NATIVE_ERROR_NAMES).sort()).toEqual([...NATIVE_ERROR_CODES].sort());
		expect(Object.isFrozen(NATIVE_ERROR_NAMES)).toBe(true);
	});

	test.each(ANEXO_C)('%s becomes %s, keeping the message, the code and the cause', (code, name) => {
		const cause = new FakeCapacitorException('report 3 out of order', code, { index: 3 });
		const error = nativeError(cause);
		expect(NATIVE_ERROR_NAMES[code]).toBe(name);
		expect(error.name).toBe(name);
		expect(error.message).toBe(`report 3 out of order (${code})`);
		expect(error.cause).toBe(cause);
		if (name === 'TypeError') {
			expect(error).toBeInstanceOf(TypeError);
			expect(error).not.toBeInstanceOf(DOMException);
		} else {
			expect(error).toBeInstanceOf(DOMException);
			expect(error).not.toBeInstanceOf(TypeError);
			expect(Object.keys(error)).not.toContain('cause');
		}
	});

	test('an unknown code is NotAllowedError with the original message and the code', () => {
		const cause = new FakeCapacitorException(
			'"OpenAuriUsb.x()" is not implemented',
			'UNIMPLEMENTED'
		);
		const error = nativeError(cause);
		expect(UNKNOWN_NATIVE_ERROR_NAME).toBe('NotAllowedError');
		expect(error).toBeInstanceOf(DOMException);
		expect(error.name).toBe('NotAllowedError');
		expect(error.message).toBe('"OpenAuriUsb.x()" is not implemented (UNIMPLEMENTED)');
		expect(error.cause).toBe(cause);
	});

	test('a missing code is NotAllowedError with exactly the original message', () => {
		const cause = new Error('bridge went away');
		const error = nativeError(cause);
		expect(error.name).toBe('NotAllowedError');
		expect(error.message).toBe('bridge went away');
		expect(error.cause).toBe(cause);
	});

	test('a prototype key is not taken for a code', () => {
		const error = nativeError({ code: 'toString', message: 'odd' });
		expect(error.name).toBe('NotAllowedError');
		expect(error.message).toBe('odd (toString)');
	});

	test('an empty message keeps the code as the message', () => {
		expect(nativeError({ code: 'USB_TIMEOUT', message: '' }).message).toBe('USB_TIMEOUT');
	});

	test('non-Error rejections still become errors', () => {
		expect(nativeError('plain text').message).toBe('plain text');
		expect(nativeError('plain text').name).toBe('NotAllowedError');
		expect(nativeError(undefined).message).toBe('OpenAuriUsb call failed');
		expect(nativeError(null).name).toBe('NotAllowedError');
		expect(nativeError(42).message).toBe('OpenAuriUsb call failed');
		expect(nativeError({ code: 7, message: 3 }).message).toBe('OpenAuriUsb call failed');
	});
});

describe('helpers', () => {
	test('nativeErrorCode reads only string codes', () => {
		expect(nativeErrorCode(new FakeCapacitorException('x', 'USB_BUSY'))).toBe('USB_BUSY');
		expect(nativeErrorCode({ code: 1 })).toBeUndefined();
		expect(nativeErrorCode('USB_BUSY')).toBeUndefined();
		expect(nativeErrorCode(null)).toBeUndefined();
	});

	test('isNativeErrorCode accepts only the contract codes', () => {
		for (const code of NATIVE_ERROR_CODES) expect(isNativeErrorCode(code)).toBe(true);
		expect(isNativeErrorCode('USB_UNKNOWN')).toBe(false);
		expect(isNativeErrorCode(undefined)).toBe(false);
	});

	test('callNative resolves with the value and maps rejections and synchronous throws', async () => {
		await expect(callNative(async () => 7)).resolves.toBe(7);
		await expect(
			callNative(() => Promise.reject(new FakeCapacitorException('busy', 'USB_BUSY')))
		).rejects.toMatchObject({ name: 'InvalidStateError', message: 'busy (USB_BUSY)' });
		await expect(
			callNative(() => {
				throw new FakeCapacitorException('bad', 'USB_BAD_ARGS');
			})
		).rejects.toBeInstanceOf(TypeError);
	});
});
