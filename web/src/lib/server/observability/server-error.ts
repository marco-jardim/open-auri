// Server error log (FXG.4). SvelteKit's default `handleError` prints unexpected errors with their
// stack, and the message may carry user input (a parsed value, an e-mail, a token from a URL).
// hooks.server.ts replaces it with this function: one JSON line per unexpected error,
//
//   { "event": "server.error", "route": "/api/v1/curves/[id]", "status": 500, "error": "TypeError" }
//
// with the route id only (never the URL, path parameters or query string), the status and the
// error class name: no message, no stack, no cause. The user still gets SvelteKit's default body
// for unexpected errors, `{ message: 'Internal Error' }` with status 500.
//
// App errors (`error(...)`), framework errors (404, 405, ...) and validation errors are expected:
// nothing is logged here (the request log already records their status) and SvelteKit's defaults
// are kept. No `$app/*` imports, so the tests can load this module.
import { routeLabel } from './request-log.ts';

export interface ServerErrorLine {
	event: 'server.error';
	route: string;
	status: number;
	error: string;
}

/** The parts of SvelteKit's `handleError` input that are read (nothing else is touched). */
export interface ServerErrorInput {
	/** `kind` of SvelteKit's CaughtError: 'app' | 'framework' | 'validation' | 'unknown'. */
	kind: string;
	error: unknown;
	event: { route: { id: string | null } };
}

/** User-facing message of an unexpected error (SvelteKit's default). */
export const INTERNAL_ERROR_MESSAGE = 'Internal Error';

const CLASS_NAME = /^[A-Za-z_$][\w$]{0,63}$/;

/** Class name of a thrown value (`name` when it is identifier-shaped), never its message. */
export function errorClass(error: unknown): string {
	if (error instanceof Error) return CLASS_NAME.test(error.name) ? error.name : 'Error';
	return error === null ? 'null' : typeof error;
}

function defaultWrite(line: ServerErrorLine): void {
	console.error(JSON.stringify(line));
}

/**
 * Body of `handleError` in hooks.server.ts. Unexpected errors: writes one PII-free line and
 * returns the default `{ message: 'Internal Error' }`. Any other kind: no line, and `undefined`
 * keeps SvelteKit's own status and message. Never throws.
 */
export function logServerError(
	input: ServerErrorInput,
	write: (line: ServerErrorLine) => void = defaultWrite
): { message: string } | undefined {
	if (input.kind !== 'unknown') return undefined;
	try {
		write({
			event: 'server.error',
			route: routeLabel(input.event.route.id),
			status: 500,
			error: errorClass(input.error)
		});
	} catch {
		// A failing log sink must not turn into a second error inside handleError.
	}
	return { message: INTERNAL_ERROR_MESSAGE };
}
