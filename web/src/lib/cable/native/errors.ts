/**
 * Native error codes of the `OpenAuriUsb` plugin mapped to the errors WebHID throws (plan
 * Anexo C), so the core transport (`open-auri/transport`, `webhid.mjs`) classifies a native
 * failure exactly like a desktop one: a `TypeError` is a programming error (rethrown while no
 * report was accepted), any `DOMException` interrupts the write and the commit is never sent.
 *
 * No `@capacitor/core` import here: this module is part of the desktop bundle.
 */

/** Codes the plugin rejects with (bridgeApi 1, schema `ErrorCode`). */
export const NATIVE_ERROR_CODES = [
	'USB_BAD_ARGS',
	'USB_NOT_FOUND',
	'USB_NOT_OPEN',
	'USB_BUSY',
	'USB_PERMISSION_DENIED',
	'USB_GUARD_REJECTED',
	'USB_TRANSFER_FAILED',
	'USB_TIMEOUT',
	'USB_DETACHED',
	'USB_ORIGIN',
	'USB_NO_HOST'
] as const;

export type NativeErrorCode = (typeof NATIVE_ERROR_CODES)[number];

/** `TypeError`, or the name of the `DOMException` a code becomes. */
export type MappedErrorName =
	| 'TypeError'
	| 'NotFoundError'
	| 'InvalidStateError'
	| 'NotAllowedError'
	| 'SecurityError'
	| 'NotSupportedError';

type ErrorNames = Readonly<Record<NativeErrorCode, MappedErrorName>>;

/** Anexo C: what each native code becomes in JS. */
export const NATIVE_ERROR_NAMES: ErrorNames = Object.freeze({
	USB_BAD_ARGS: 'TypeError',
	USB_NOT_FOUND: 'NotFoundError',
	USB_NOT_OPEN: 'InvalidStateError',
	USB_BUSY: 'InvalidStateError',
	USB_PERMISSION_DENIED: 'NotAllowedError',
	USB_GUARD_REJECTED: 'NotAllowedError',
	USB_TRANSFER_FAILED: 'NotAllowedError',
	USB_TIMEOUT: 'NotAllowedError',
	USB_DETACHED: 'NotAllowedError',
	USB_ORIGIN: 'SecurityError',
	USB_NO_HOST: 'NotSupportedError'
});

/** Name used for an unknown or missing code: the failure still interrupts, never passes. */
export const UNKNOWN_NATIVE_ERROR_NAME: MappedErrorName = 'NotAllowedError';

const FALLBACK_MESSAGE = 'OpenAuriUsb call failed';

export function isNativeErrorCode(value: unknown): value is NativeErrorCode {
	return (NATIVE_ERROR_CODES as readonly unknown[]).includes(value);
}

/** The `code` of a plugin rejection (`CapacitorException`), when it is a string. */
export function nativeErrorCode(cause: unknown): string | undefined {
	if (typeof cause !== 'object' || cause === null) return undefined;
	const code: unknown = (cause as { code?: unknown }).code;
	return typeof code === 'string' ? code : undefined;
}

function originalMessage(cause: unknown): string {
	if (typeof cause === 'string') return cause;
	if (typeof cause === 'object' && cause !== null) {
		const message: unknown = (cause as { message?: unknown }).message;
		if (typeof message === 'string') return message;
	}
	return FALLBACK_MESSAGE;
}

function messageWithCode(original: string, code: string | undefined): string {
	if (code === undefined) return original;
	if (original === '') return code;
	return `${original} (${code})`;
}

/**
 * The WebHID-like error for a plugin rejection. The original message is kept, followed by the
 * native code in parentheses when there is one; the rejection itself is the error's `cause`.
 * Unknown or missing codes become `DOMException('NotAllowedError')`. Never returns undefined:
 * callers throw the result.
 */
export function nativeError(cause: unknown): TypeError | DOMException {
	const code = nativeErrorCode(cause);
	const message = messageWithCode(originalMessage(cause), code);
	const name = isNativeErrorCode(code) ? NATIVE_ERROR_NAMES[code] : UNKNOWN_NATIVE_ERROR_NAME;
	if (name === 'TypeError') return new TypeError(message, { cause });
	const error = new DOMException(message, name);
	// DOMException takes no options bag everywhere: attach the cause like Error does.
	Object.defineProperty(error, 'cause', {
		value: cause,
		writable: true,
		enumerable: false,
		configurable: true
	});
	return error;
}

/**
 * Runs one plugin call; a rejection (or a synchronous throw) becomes {@link nativeError}.
 * Never resolve with the plugin proxy itself from here: Capacitor's proxy answers every
 * property, `then` included.
 */
export async function callNative<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (cause) {
		throw nativeError(cause);
	}
}
