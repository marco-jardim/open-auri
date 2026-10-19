// `/c/[id]` (T4.5): public shared-curve page, rendered on the server for the OG tags. The lineage
// is read through the repository visibility with the session viewer: unknown, private (of
// someone else) or moderated → 404; retracted → 410. With `?s=<shareId>` of this lineage, the
// anonymous daily open counter is incremented after the response (waitUntil), through the same
// service function and rate rule as `POST /api/v1/shares/[id]/open`.
import { error } from '@sveltejs/kit';
import type { SharedCurvePageData } from '#lib/components/pages/shared-curve/types.ts';
import { checkUser, type AuthLocals } from '#lib/server/auth/guards.ts';
import { getServerEnv } from '#lib/server/env.ts';
import {
	loadSharedCurve,
	recordShareOpenLimited,
	sharedCurveMeta
} from '#lib/server/social/shares.ts';
import type { PageServerLoad } from './$types';

export const prerender = false;

/** The part of the RequestEvent this load uses (tests pass synthetic events). */
interface SharedCurveLoadEvent {
	params: { id: string };
	url: URL;
	request: Request;
	locals: AuthLocals;
	platform?: { readonly env?: unknown } | undefined;
}

type WaitUntil = (promise: Promise<unknown>) => void;

/** `platform.ctx.waitUntil` (rebuilt by hooks.server.ts), or null outside the Worker. */
function waitUntilOf(platform: unknown): WaitUntil | null {
	if (typeof platform !== 'object' || platform === null || !('ctx' in platform)) return null;
	const ctx: unknown = platform.ctx;
	if (typeof ctx !== 'object' || ctx === null || !('waitUntil' in ctx)) return null;
	const waitUntil: unknown = ctx.waitUntil;
	if (typeof waitUntil !== 'function') return null;
	return (promise) => {
		Reflect.apply(waitUntil, ctx, [promise]);
	};
}

async function loadPage(event: SharedCurveLoadEvent): Promise<SharedCurvePageData> {
	const env = getServerEnv(event.platform);
	const current = checkUser(event.locals);
	const userId = current.ok ? current.user.id : null;
	const shareParam = event.url.searchParams.get('s');

	// While YOLO_PUBLICATION is off, someone else's YOLO head is a 404 here (the owner still sees it).
	const result = await loadSharedCurve(env.db, { userId }, event.params.id, shareParam, {
		yoloPublication: env.yoloPublication
	});
	if (result.kind === 'not-found') error(404, 'Not found');
	if (result.kind === 'gone') error(410, 'Gone');

	const { curve } = result;
	if (curve.shareId !== null) {
		const counting = recordShareOpenLimited(
			env,
			{ request: event.request, locals: event.locals },
			curve.shareId
		).catch((cause: unknown) => {
			// The page never fails because of the counter; one PII-free line.
			const name = cause instanceof Error ? cause.name : typeof cause;
			console.error(JSON.stringify({ event: 'shares.open_failed', error: name }));
			return false;
		});
		const waitUntil = waitUntilOf(event.platform);
		if (waitUntil) waitUntil(counting);
		else await counting;
	}

	return {
		curve,
		meta: sharedCurveMeta(env.publicOrigin, curve),
		signedIn: userId !== null
	};
}

export const load: PageServerLoad = (event) => loadPage(event);
