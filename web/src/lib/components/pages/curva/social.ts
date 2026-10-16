import { encodeS1, normalizeText, S1Error } from 'open-auri/share';
import {
	createSocialApi,
	type CurveOrigin,
	type EnqueueInput,
	type SocialFetch
} from '#lib/social/index.ts';
import type { Curve } from './model.ts';
import { REASON_CODES, reasonText } from './reasons.ts';
import { m } from '#lib/paraglide/messages.js';

export function currentS1(curve: Curve): string | null {
	try {
		return encodeS1(curve);
	} catch (cause) {
		if (cause instanceof S1Error) return null;
		throw cause;
	}
}

/** The shared client deliberately accepts any 2xx; publication requires exactly 201. */
export function curvaSocialApi(fetcher: SocialFetch = (input, init) => fetch(input, init)) {
	return createSocialApi({
		fetch: async (input, init) => {
			const response = await fetcher(input, init);
			if (init.method === 'POST' && input === '/api/v1/curves' && response.ok) {
				if (response.status !== 201) {
					return new Response('{"error":{"code":"INTERNAL"}}', { status: 502 });
				}
			}
			return response;
		}
	});
}

export function socialEnvelope(
	curve: Curve,
	meta: { name: string; description: string; license: 'CC0-1.0' | 'CC-BY-4.0'; locale: string }
) {
	return {
		format: 'open-auri/preset@1',
		name: normalizeText(meta.name),
		description: normalizeText(meta.description),
		license: meta.license,
		source: 'custom',
		code: encodeS1(curve),
		preampDb: curve.preampDb,
		bands: curve.bands,
		lang: meta.locale.startsWith('en') ? 'en-US' : 'pt-BR',
		createdAt: new Date().toISOString()
	};
}

/** API details are untrusted: only known gate codes reach the existing localized mapper. */
export function serverGateMessages(details: unknown): string[] {
	const reasons: unknown =
		typeof details === 'object' && details !== null ? Reflect.get(details, 'reasons') : null;
	if (!Array.isArray(reasons) || reasons.length === 0) return [m.curva_reason_unknown()];
	return reasons.map((entry: unknown) => {
		const code: unknown =
			typeof entry === 'string'
				? entry
				: typeof entry === 'object' && entry !== null
					? Reflect.get(entry, 'code')
					: null;
		const known = REASON_CODES.find((candidate) => candidate === code);
		if (!known) return m.curva_reason_unknown();
		const stage: unknown =
			typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'stage') : undefined;
		return reasonText({ code: known, ...(typeof stage === 'number' ? { stage } : {}) });
	});
}

/** Audio-context seconds, not wall time. Gaps, silence, A-side and edits break continuity. */
export class PreviewActivity {
	#session = -1;
	#sent = false;
	#s1: string | null = null;
	#since: number | null = null;
	#last: number | null = null;

	interrupt(): void {
		this.#since = this.#last = null;
	}

	sample(
		session: number,
		s1: string | null,
		origin: CurveOrigin | null,
		seconds: number | null
	): EnqueueInput | null {
		if (session !== this.#session) {
			this.#session = session;
			this.#sent = false;
			this.interrupt();
		}
		if (s1 !== this.#s1) {
			this.#s1 = s1;
			this.interrupt();
		}
		if (!s1 || !origin || seconds === null || !Number.isFinite(seconds)) {
			this.interrupt();
			return null;
		}
		if (this.#sent) return null;
		if (this.#last === null || seconds < this.#last || seconds - this.#last > 0.5) {
			this.#since = seconds;
		}
		this.#last = seconds;
		const durationMs = Math.floor((seconds - (this.#since ?? seconds)) * 1000);
		if (durationMs < 10_000) return null;
		this.#sent = true;
		return { kind: 'previewed', lineageId: origin.lineageId, durationMs };
	}
}
