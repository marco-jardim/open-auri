// Request handlers of the two non-form endpoints of /conta, kept here (not in the routes) so the
// workerd tests drive them with real Requests:
//   - POST /conta/exportar: the LGPD export as a JSON attachment;
//   - POST /conta/politica: signed-in acknowledgement of the current policy (PolicyBanner).
// Both: same-origin only (CSRF; a JSON POST is outside SvelteKit's form check and the download
// must not be triggerable from another site), signed-in only, never cached.
import type { D1Database } from '@cloudflare/workers-types';
import type { AuthLocals } from '../auth/guards.ts';
import { accountAccess, isSameOriginRequest } from './access.ts';
import { buildAccountExport, exportResponse, type ExportSection } from './export.ts';
import { acceptCurrentPolicy } from './policy.ts';

export interface EndpointInput {
	request: Request;
	locals: AuthLocals;
	db: D1Database;
	publicOrigin: string;
	now?: number;
}

const NO_STORE = { 'cache-control': 'no-store' };

function answer(status: number, body?: unknown): Response {
	if (body === undefined) return new Response(null, { status, headers: NO_STORE });
	return Response.json(body, { status, headers: NO_STORE });
}

export async function handleExportRequest(
	input: EndpointInput,
	sections?: readonly ExportSection[]
): Promise<Response> {
	if (!isSameOriginRequest(input.request, input.publicOrigin)) {
		return answer(403, { code: 'INVALID_ORIGIN' });
	}
	const access = accountAccess(input.locals);
	if (!access.ok) return answer(access.status, { code: access.code });
	const now = input.now ?? Date.now();
	const document = await buildAccountExport(
		{ db: input.db, userId: access.user.id, currentSessionId: access.session.id, now },
		sections
	);
	return exportResponse(document, now);
}

export async function handlePolicyRequest(input: EndpointInput): Promise<Response> {
	const { request } = input;
	if (!isSameOriginRequest(request, input.publicOrigin)) {
		return answer(403, { code: 'INVALID_ORIGIN' });
	}
	const access = accountAccess(input.locals);
	if (!access.ok) return answer(access.status, { code: access.code });
	if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) {
		return answer(415, { code: 'UNSUPPORTED_MEDIA_TYPE' });
	}
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return answer(400, { code: 'INVALID_JSON' });
	}
	const version =
		typeof body === 'object' && body !== null ? Reflect.get(body, 'version') : undefined;
	const result = await acceptCurrentPolicy(
		input.db,
		access.user.id,
		version,
		input.now ?? Date.now()
	);
	if (!result.ok) return answer(400, { code: 'INVALID_VERSION' });
	return answer(200, { version: result.version });
}
