// Social wiring pace for the root layout (FUX.Q N6, issue #35). The layout attaches the social
// outbox bridge as the app context's optional `prepare`; this module bounds how long the first
// mount waits for it and paces the background retries after a failure.
//
// Timing and pacing only: no static import of the social group or the app runtime (this module
// sits in the static closure of every route, like `runtime.ts`).

/** First mount: the cable chrome waits at most this long for the social wiring. */
export const SOCIAL_ATTACH_TIMEOUT_MS = 8000;

/** After a failure, at most one wiring attempt starts per this interval. */
export const SOCIAL_RETRY_INTERVAL_MS = 10_000;

/** Undoes one social wiring (stops its outbox bridge); idempotent. */
export type SocialStop = () => void;

/** The social wiring did not attach in time: a stalled chunk request, not a failed one. */
export class SocialAttachTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`Social wiring did not attach within ${timeoutMs} ms`);
		this.name = 'SocialAttachTimeoutError';
		this.timeoutMs = timeoutMs;
	}
}

/**
 * Races one attach against `timeoutMs`. Settles like `attempt` when it lands in time; rejects
 * with `SocialAttachTimeoutError` otherwise. An attach that lands after the timeout hands its
 * cleanup to `onlate` (the caller keeps or undoes it); a late failure is dropped, since the
 * timeout already reported this attempt.
 */
export function raceAttach(
	attempt: Promise<SocialStop>,
	timeoutMs: number,
	onlate: (stop: SocialStop) => void
): Promise<SocialStop> {
	return new Promise((resolve, reject) => {
		let late = false;
		const timer = setTimeout(() => {
			late = true;
			reject(new SocialAttachTimeoutError(timeoutMs));
		}, timeoutMs);
		attempt.then(
			(stop) => {
				if (late) {
					onlate(stop);
					return;
				}
				clearTimeout(timer);
				resolve(stop);
			},
			(error: unknown) => {
				if (late) return;
				clearTimeout(timer);
				reject(error);
			}
		);
	});
}

export interface SocialAttacherOptions<C> {
	/** Wires social for `client` and resolves with its cleanup (the layout's `attachSocial`). */
	attach: (client: C) => Promise<SocialStop>;
	/** Whether `client` is still the layout's live app; wiring that lands for another is undone. */
	owns: (client: C) => boolean;
	/** Social became unavailable or available again (the layout's `data-social` flag). */
	onavailable: (available: boolean) => void;
	timeoutMs?: number;
	retryIntervalMs?: number;
	now?: () => number;
	warn?: (message: string, error: unknown) => void;
}

/**
 * The layout's social attach policy:
 * - `prepare` (the context's optional prepare) races the first attach against the timeout. A
 *   failure or a timeout marks social unavailable and rejects, so the context logs it and
 *   publishes the app without social: cable status, rescue notice and writes never wait for it.
 *   An attach that lands after its timeout still wires social for the live app.
 * - `retry` starts a background attempt after a failure, at most one per `retryIntervalMs` and
 *   never while one is still running (also one that outlived its timeout: the social chunk
 *   request is shared, so a second attempt would only wait on the same request). Only the first
 *   failed retry of an outage is logged; a successful attach ends the outage.
 */
export function createSocialAttacher<C>(options: SocialAttacherOptions<C>) {
	const {
		attach,
		owns,
		onavailable,
		timeoutMs = SOCIAL_ATTACH_TIMEOUT_MS,
		retryIntervalMs = SOCIAL_RETRY_INTERVAL_MS,
		now = () => Date.now(),
		warn = (message: string, error: unknown) => console.warn(message, error)
	} = options;
	let unavailable = false;
	let inflight = false;
	let lastAttemptAt = Number.NEGATIVE_INFINITY;
	let warned = false;

	function setAvailable(available: boolean): void {
		const next = !available;
		if (unavailable === next) return;
		unavailable = next;
		if (available) warned = false;
		onavailable(available);
	}

	function start(client: C): Promise<SocialStop> {
		inflight = true;
		lastAttemptAt = now();
		let attempt: Promise<SocialStop>;
		try {
			attempt = attach(client);
		} catch (error) {
			attempt = Promise.reject(error);
		}
		const settled = () => {
			inflight = false;
		};
		attempt.then(settled, settled);
		return attempt;
	}

	/** Wiring that landed outside the context's prepare: kept for the live app, else undone. */
	function adopt(client: C, stop: SocialStop): void {
		if (!owns(client)) {
			stop();
			return;
		}
		setAvailable(true);
	}

	return {
		/** True after a failed or timed-out attach, until one lands. */
		get unavailable() {
			return unavailable;
		},
		prepare(client: C): Promise<SocialStop> {
			return raceAttach(start(client), timeoutMs, (stop) => adopt(client, stop)).then(
				(stop) => {
					setAvailable(true);
					return stop;
				},
				(error: unknown) => {
					setAvailable(false);
					throw error;
				}
			);
		},
		/** Never awaited by a write or the rescue. Returns whether an attempt started. */
		retry(client: C | null | undefined): boolean {
			if (!unavailable || inflight || !client || !owns(client)) return false;
			if (now() - lastAttemptAt < retryIntervalMs) return false;
			const live: C = client;
			start(live).then(
				(stop) => adopt(live, stop),
				(error: unknown) => {
					if (warned) return;
					warned = true;
					warn('Social runtime still unavailable; the outbox stays unavailable', error);
				}
			);
			return true;
		}
	};
}
