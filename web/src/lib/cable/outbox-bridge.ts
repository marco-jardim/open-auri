// T4.16: a real, successful cable write of a community curve becomes one `installed` activity.
// Only `cable:written` is heard: the service dispatches it after a real committed write and never
// for simulated, interrupted or refused writes (service.ts `journalSequence`). A Modo YOLO write
// counts too (its detail is marked `profile: 'yolo'`): the install happened. As defense in depth
// the bridge also drops any detail whose journal entry is not `ok` and anything heard while the
// service reports simulated mode. The event goes through the social outbox (`enqueue`), never
// straight to the API, and only when `originOf` finds the exact published bytes.
//
// Only a signed-in, verified person's write counts (FX4.2): the account id is captured when the
// write is heard, nothing is looked up or queued without one, and the outbox refuses the event if
// the session changed before it was queued. Anonymous writes are never stored for later.
import { encodeS1 } from 'open-auri/share';
import { CABLE_WRITTEN_EVENT } from '#lib/cable/service.ts';
import type { CableWrittenDetail } from '#lib/cable/types.ts';
import { originOf, type CurveOrigin, type OriginsOptions } from '#lib/social/origins.ts';
import type { EnqueueInput, EnqueueResult } from '#lib/social/outbox.ts';

export interface OutboxBridgeApp {
	cable: { events: EventTarget };
	/** Reactive cable state of the client app; `simulated` mode never produces activity. */
	cableState?: { mode: string } | null;
}

export interface OutboxBridgeOutbox {
	enqueue(input: EnqueueInput, options?: { actedAs?: string | null }): Promise<EnqueueResult>;
}

/** Who is signed in (`createSocialSession`): read when the write is heard. */
export interface OutboxBridgeSession {
	readonly signedIn: boolean;
	readonly verified: boolean;
	readonly accountId: string | null;
}

export interface OutboxBridgeOptions {
	app: OutboxBridgeApp;
	outbox: OutboxBridgeOutbox;
	session: OutboxBridgeSession;
	/** Storage options for the default `originOf` lookup. */
	origins?: OriginsOptions;
	/** Replaces the `originOf` lookup (tests). */
	lookup?: (s1: string) => Promise<CurveOrigin | null>;
	/** Called after each enqueue (e.g. to `flush` the outbox). */
	onqueued?: (result: EnqueueResult) => void;
	log?: (event: string, data: Record<string, string>) => void;
}

function defaultLog(event: string, data: Record<string, string>): void {
	console.warn(JSON.stringify({ event, ...data }));
}

/** True only for the detail of a committed real write (journal status `ok`). */
export function isRealWrite(value: unknown): value is CableWrittenDetail {
	if (typeof value !== 'object' || value === null) return false;
	const { entry, bands, preampDb } = value as Record<string, unknown>;
	if (typeof entry !== 'object' || entry === null) return false;
	const status = (entry as Record<string, unknown>).status;
	return status === 'ok' && Array.isArray(bands) && typeof preampDb === 'number';
}

/**
 * Listens to the app's real write event and enqueues `installed` for curves with a known
 * community origin. Returns the unsubscribe function (call it when the layout unmounts).
 */
export function startOutboxBridge(options: OutboxBridgeOptions): () => void {
	const { app, outbox, session } = options;
	const log = options.log ?? defaultLog;
	const lookup = options.lookup ?? ((s1: string) => originOf(s1, options.origins));
	let stopped = false;

	async function handle(detail: CableWrittenDetail, actedAs: string): Promise<void> {
		let s1: string;
		try {
			s1 = encodeS1({ bands: detail.bands, preampDb: detail.preampDb });
		} catch (error) {
			log('social.bridge.s1', { error: (error as Error).name });
			return;
		}
		const origin = await lookup(s1);
		if (origin === null || stopped) return;
		const result = await outbox.enqueue(
			{ kind: 'installed', lineageId: origin.lineageId },
			{ actedAs }
		);
		if (!result.ok) log('social.bridge.enqueue', { status: 'not-queued', reason: result.reason });
		options.onqueued?.(result);
	}

	const listener = (event: Event) => {
		if (stopped || !(event instanceof CustomEvent)) return;
		if (app.cableState?.mode === 'simulated') return;
		const detail: unknown = event.detail;
		if (!isRealWrite(detail)) return;
		// The person who wrote, read now: anonymous or unverified writes are not activity.
		const actedAs = session.accountId;
		if (!session.signedIn || !session.verified || actedAs === null) return;
		handle(detail, actedAs).catch((error: unknown) => {
			log('social.bridge.failed', { error: (error as Error).name });
		});
	};
	app.cable.events.addEventListener(CABLE_WRITTEN_EVENT, listener);
	return () => {
		stopped = true;
		app.cable.events.removeEventListener(CABLE_WRITTEN_EVENT, listener);
	};
}
