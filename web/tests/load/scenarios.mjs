// Pure pieces of the load runner (T5.6): argument parsing, origin safety, request building and
// target evaluation. No network and no autocannon import here, so `node --test` covers it offline.
//
// The client IP is never spoofed (no `cf-connecting-ip` or `x-forwarded-for`): on staging the edge
// sets the real address, and the per-IP rate limits (`RL_API`, `RL_WRITE`) apply to the machine
// running the test. Keep connections modest and read the 429 count in the summary.

/** @type {readonly string[]} */
export const SCENARIOS = Object.freeze(['feed', 'curve-page', 'rankings', 'publish']);

/** p95 targets in milliseconds: cached reads < 300 ms, publication (cached gate) < 1.5 s. */
export const TARGETS = Object.freeze({
	feed: 300,
	'curve-page': 300,
	rankings: 300,
	publish: 1500
});

/** Minimum successful samples for a verdict; fewer means the run measured nothing useful. */
export const MIN_OK = Object.freeze({ read: 50, write: 5 });

/** Above this share of non-2xx responses (or socket errors) the scenario fails. */
export const MAX_FAILURE_RATIO = 0.05;

/** Publication is bounded by the per-user quota (30 per UTC day) and `RL_WRITE` (30 per 60 s). */
export const PUBLISH_MAX_AMOUNT = 30;
export const PUBLISH_DEFAULT_AMOUNT = 20;
export const PUBLISH_MAX_CONNECTIONS = 2;

/** Body limit of `POST /api/v1/curves` (docs/api.md). */
export const PUBLISH_BODY_LIMIT = 32 * 1024;

/** Cloudflare's documented dummy token, accepted only by the Turnstile test secret keys. */
export const TURNSTILE_TEST_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

export const ENVELOPE_FORMAT = 'open-auri/preset@1';

const PRODUCTION_HOST = 'open-auri.com';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const VISIBILITIES = new Set(['private', 'unlisted', 'public']);

export class UsageError extends Error {
	/** @param {string} message */
	constructor(message) {
		super(message);
		this.name = 'UsageError';
	}
}

export const USAGE = [
	'Uso: node web/tests/load/run.mjs --origin <url> [opções]',
	'',
	'  --origin <url>         staging (https://<nome>-staging.<sub>.workers.dev) ou localhost',
	'  --scenario <nome>      feed | curve-page | rankings | publish | all (padrão: all)',
	'  --duration <s>         duração por cenário de leitura, 1 a 300 (padrão: 20)',
	'  --connections <n>      conexões simultâneas, 1 a 100 (padrão: 20; publish usa no máximo 2)',
	'  --rate <rps>           teto global de requisições por segundo (opcional)',
	'  --curve <lineageId>    linhagem do cenário curve-page (padrão: a primeira do feed)',
	'  --envelope <arquivo>   JSON do envelope S5 já aprovado no gate (obrigatório para publish)',
	'  --visibility <v>       private | unlisted | public para publish (padrão: private)',
	`  --amount <n>           publicações no cenário publish, 1 a ${PUBLISH_MAX_AMOUNT} (padrão: ${PUBLISH_DEFAULT_AMOUNT})`,
	'',
	'Ambiente: LOAD_SESSION_COOKIE (cabeçalho Cookie de uma conta verificada de staging, só para',
	'publish); LOAD_TURNSTILE_TOKEN (opcional; padrão: token de teste do Turnstile).'
].join('\n');

const FLAGS = new Set([
	'origin',
	'scenario',
	'duration',
	'connections',
	'rate',
	'curve',
	'envelope',
	'visibility',
	'amount',
	'help'
]);

/**
 * @param {string} name
 * @param {string} raw
 * @param {number} min
 * @param {number} max
 */
function parseIntFlag(name, raw, min, max) {
	if (!/^\d{1,6}$/.test(raw)) throw new UsageError(`--${name} precisa ser um inteiro`);
	const value = Number(raw);
	if (value < min || value > max) {
		throw new UsageError(`--${name} precisa estar entre ${min} e ${max}`);
	}
	return value;
}

/**
 * @typedef {{
 *   origin: string,
 *   scenarios: string[],
 *   duration: number,
 *   connections: number,
 *   rate: number | null,
 *   curve: string | null,
 *   envelope: string | null,
 *   visibility: string,
 *   amount: number,
 *   help: boolean
 * }} LoadArgs
 */

/**
 * Parses `--flag value` and `--flag=value`. The origin is checked by `assertSafeOrigin`.
 * @param {readonly string[]} argv arguments after the script path
 * @returns {LoadArgs}
 */
export function parseArgs(argv) {
	/** @type {Map<string, string>} */
	const raw = new Map();
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!token.startsWith('--')) throw new UsageError(`argumento inesperado: ${token}`);
		const eq = token.indexOf('=');
		const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
		if (!FLAGS.has(name)) throw new UsageError(`opção desconhecida: --${name}`);
		if (raw.has(name)) throw new UsageError(`opção repetida: --${name}`);
		if (name === 'help') {
			if (eq !== -1) throw new UsageError('--help não recebe valor');
			raw.set(name, '');
			continue;
		}
		let value;
		if (eq !== -1) {
			value = token.slice(eq + 1);
		} else {
			value = argv[i + 1];
			if (value === undefined || value.startsWith('--')) {
				throw new UsageError(`--${name} precisa de um valor`);
			}
			i++;
		}
		if (value === '') throw new UsageError(`--${name} precisa de um valor`);
		raw.set(name, value);
	}

	const help = raw.has('help');
	const origin = raw.get('origin');
	if (origin === undefined && !help) throw new UsageError('--origin é obrigatório');

	const scenario = raw.get('scenario') ?? 'all';
	if (scenario !== 'all' && !SCENARIOS.includes(scenario)) {
		throw new UsageError(`--scenario inválido: use ${SCENARIOS.join(' | ')} | all`);
	}

	const curve = raw.get('curve') ?? null;
	if (curve !== null && !ID_PATTERN.test(curve)) {
		throw new UsageError('--curve precisa ser um id de linhagem (letras, dígitos, _ ou -)');
	}

	const visibility = raw.get('visibility') ?? 'private';
	if (!VISIBILITIES.has(visibility)) {
		throw new UsageError('--visibility inválido: use private | unlisted | public');
	}

	/**
	 * @param {string} name
	 * @param {number} min
	 * @param {number} max
	 * @param {number | null} fallback
	 */
	const intFlag = (name, min, max, fallback) => {
		const value = raw.get(name);
		return value === undefined ? fallback : parseIntFlag(name, value, min, max);
	};
	return {
		origin: origin ?? '',
		scenarios: scenario === 'all' ? [...SCENARIOS] : [scenario],
		duration: /** @type {number} */ (intFlag('duration', 1, 300, 20)),
		connections: /** @type {number} */ (intFlag('connections', 1, 100, 20)),
		rate: intFlag('rate', 1, 10_000, null),
		curve,
		envelope: raw.get('envelope') ?? null,
		visibility,
		amount: /** @type {number} */ (
			intFlag('amount', 1, PUBLISH_MAX_AMOUNT, PUBLISH_DEFAULT_AMOUNT)
		),
		help
	};
}

/**
 * Accepts only loopback origins (http or https, any port) and the staging Worker on workers.dev
 * (https, first label ending in `-staging`). Refuses `open-auri.com` and its subdomains first, then
 * anything else, including the production `workers.dev` (it redirects to production).
 * @param {string} input
 * @returns {string} the normalized origin (`scheme://host[:port]`)
 */
export function assertSafeOrigin(input) {
	let url;
	try {
		url = new URL(input);
	} catch {
		throw new UsageError('--origin não é uma URL válida');
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new UsageError('--origin precisa ser http ou https');
	}
	if (url.username !== '' || url.password !== '') {
		throw new UsageError('--origin não pode conter credenciais');
	}
	const host = url.hostname.toLowerCase().replace(/\.$/, '');
	if (host === PRODUCTION_HOST || host.endsWith(`.${PRODUCTION_HOST}`)) {
		throw new UsageError('recusado: --origin aponta para produção; a carga roda só em staging');
	}
	if (LOOPBACK_HOSTS.has(host)) return url.origin;
	if (host.endsWith('.workers.dev')) {
		if (url.protocol !== 'https:') throw new UsageError('recusado: workers.dev exige https');
		const labels = host.split('.');
		if (labels.length < 4 || !labels[0].endsWith('-staging')) {
			throw new UsageError(
				'recusado: em workers.dev só o Worker de staging (<nome>-staging.<sub>.workers.dev)'
			);
		}
		return url.origin;
	}
	throw new UsageError('recusado: --origin precisa ser o staging em workers.dev ou localhost');
}

/**
 * Rejects header injection and absurd sizes; the value itself is never printed.
 * @param {string | undefined} value
 * @returns {string}
 */
export function assertSessionCookie(value) {
	if (value === undefined || value.trim() === '') {
		throw new UsageError('publish exige LOAD_SESSION_COOKIE com a sessão de uma conta verificada');
	}
	if (/[\r\n\0]/.test(value) || value.length > 8192) {
		throw new UsageError('LOAD_SESSION_COOKIE inválido');
	}
	return value.trim();
}

/**
 * Accepts either the bare S5 envelope or a full request body `{ envelope, ... }`.
 * @param {unknown} parsed JSON already parsed from `--envelope`
 * @returns {Record<string, unknown>}
 */
export function extractEnvelope(parsed) {
	const isObject = (/** @type {unknown} */ v) =>
		typeof v === 'object' && v !== null && !Array.isArray(v);
	if (!isObject(parsed)) throw new UsageError('--envelope precisa conter um objeto JSON');
	const record = /** @type {Record<string, unknown>} */ (parsed);
	const envelope = isObject(record.envelope)
		? /** @type {Record<string, unknown>} */ (record.envelope)
		: record;
	if (envelope.format !== ENVELOPE_FORMAT) {
		throw new UsageError(`--envelope precisa ter format "${ENVELOPE_FORMAT}"`);
	}
	return envelope;
}

/**
 * @param {unknown} feed body of `GET /api/v1/feed`
 * @returns {string | null} the first lineage id, or null when the feed is empty or malformed
 */
export function pickLineageId(feed) {
	if (typeof feed !== 'object' || feed === null) return null;
	const items = /** @type {{ items?: unknown }} */ (feed).items;
	if (!Array.isArray(items)) return null;
	for (const item of items) {
		const id = item?.lineage?.id;
		if (typeof id === 'string' && ID_PATTERN.test(id)) return id;
	}
	return null;
}

/**
 * @typedef {{
 *   name: string,
 *   kind: 'read' | 'write',
 *   method: 'GET' | 'POST',
 *   path: string,
 *   headers: Record<string, string>,
 *   body?: string,
 *   targetP95Ms: number,
 *   expectStatus: number
 * }} ScenarioRequest
 */

const USER_AGENT = 'open-auri-load/1 (autocannon)';

/**
 * @param {string} name one of SCENARIOS
 * @param {{
 *   origin: string,
 *   curve?: string | null,
 *   cookie?: string,
 *   turnstileToken?: string,
 *   envelope?: Record<string, unknown>,
 *   visibility?: string
 * }} ctx
 * @returns {ScenarioRequest}
 */
export function buildScenario(name, ctx) {
	const json = { accept: 'application/json', 'user-agent': USER_AGENT };
	switch (name) {
		case 'feed':
			return {
				name,
				kind: 'read',
				method: 'GET',
				path: '/api/v1/feed',
				headers: json,
				targetP95Ms: TARGETS.feed,
				expectStatus: 200
			};
		case 'rankings':
			return {
				name,
				kind: 'read',
				method: 'GET',
				path: '/api/v1/rankings',
				headers: json,
				targetP95Ms: TARGETS.rankings,
				expectStatus: 200
			};
		case 'curve-page': {
			if (!ctx.curve || !ID_PATTERN.test(ctx.curve)) {
				throw new UsageError('curve-page precisa de um id de linhagem');
			}
			return {
				name,
				kind: 'read',
				method: 'GET',
				path: `/c/${encodeURIComponent(ctx.curve)}`,
				headers: { accept: 'text/html', 'user-agent': USER_AGENT },
				targetP95Ms: TARGETS['curve-page'],
				expectStatus: 200
			};
		}
		case 'publish': {
			const cookie = assertSessionCookie(ctx.cookie);
			if (!ctx.envelope) throw new UsageError('publish exige --envelope');
			const body = JSON.stringify({
				envelope: ctx.envelope,
				visibility: ctx.visibility ?? 'private'
			});
			if (new TextEncoder().encode(body).length > PUBLISH_BODY_LIMIT) {
				throw new UsageError('o corpo de publish passa de 32 KiB');
			}
			return {
				name,
				kind: 'write',
				method: 'POST',
				path: '/api/v1/curves',
				headers: {
					...json,
					'content-type': 'application/json',
					origin: assertSafeOrigin(ctx.origin),
					cookie,
					'x-turnstile-token': ctx.turnstileToken ?? TURNSTILE_TEST_TOKEN
				},
				body,
				targetP95Ms: TARGETS.publish,
				expectStatus: 201
			};
		}
		default:
			throw new UsageError(`cenário desconhecido: ${name}`);
	}
}

/**
 * Nearest-rank percentile.
 * @param {readonly number[]} sorted ascending
 * @param {number} q 0 < q <= 100
 * @returns {number | null}
 */
export function percentile(sorted, q) {
	if (sorted.length === 0) return null;
	const rank = Math.ceil((q / 100) * sorted.length);
	return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** @param {number | null} v */
const round1 = (v) => (v === null ? null : Math.round(v * 10) / 10);

/**
 * @typedef {{
 *   okLatenciesMs: number[],
 *   statusCounts: Record<string, number>,
 *   errors: number,
 *   timeouts: number,
 *   elapsedMs: number
 * }} Samples
 */

/**
 * Latency percentiles count only 2xx responses: fast 429s or 404s would otherwise make a broken run
 * look good. The verdict also requires enough successful samples and few failures.
 * @param {ScenarioRequest} scenario
 * @param {Samples} samples
 */
export function evaluate(scenario, samples) {
	const sorted = [...samples.okLatenciesMs].sort((a, b) => a - b);
	const ok = sorted.length;
	let responses = 0;
	for (const n of Object.values(samples.statusCounts)) responses += n;
	const non2xx = responses - ok;
	const total = responses + samples.errors + samples.timeouts;
	const failures = non2xx + samples.errors + samples.timeouts;
	const failureRatio = total === 0 ? 1 : failures / total;
	const seconds = samples.elapsedMs > 0 ? samples.elapsedMs / 1000 : null;

	const p95 = percentile(sorted, 95);
	const minOk = MIN_OK[scenario.kind];
	const enoughSamples = ok >= minOk;
	const withinTarget = p95 !== null && p95 < scenario.targetP95Ms;
	const fewFailures = failureRatio <= MAX_FAILURE_RATIO;
	/** @type {string[]} */
	const reasons = [];
	if (!enoughSamples) reasons.push(`apenas ${ok} respostas 2xx (mínimo ${minOk})`);
	if (p95 !== null && !withinTarget) {
		reasons.push(`p95 ${round1(p95)} ms >= meta ${scenario.targetP95Ms} ms`);
	}
	if (!fewFailures) {
		reasons.push(
			`${failures} de ${total} falharam (non-2xx, erros ou timeouts), ` +
				`acima de ${MAX_FAILURE_RATIO * 100}%`
		);
	}
	const rateLimited = (samples.statusCounts['429'] ?? 0) + (samples.statusCounts['503'] ?? 0);
	if (rateLimited > 0) {
		reasons.push(
			`${rateLimited} respostas 429/503 (rate limit por IP, cota ou somente leitura); ` +
				'reduza --connections ou use --rate'
		);
	}
	const redirects = Object.entries(samples.statusCounts)
		.filter(([code]) => code.startsWith('3') && code !== '304')
		.reduce((sum, [, n]) => sum + n, 0);
	if (redirects > 0) reasons.push(`${redirects} redirecionamentos: a origem não é a de staging?`);

	const pass = enoughSamples && withinTarget && fewFailures;
	return {
		name: scenario.name,
		method: scenario.method,
		path: scenario.path,
		status: pass ? 'PASS' : 'FAIL',
		targetP95Ms: scenario.targetP95Ms,
		latencyMs: {
			p50: round1(percentile(sorted, 50)),
			p95: round1(p95),
			p99: round1(percentile(sorted, 99)),
			max: round1(ok === 0 ? null : sorted[ok - 1])
		},
		requests: {
			total,
			ok,
			non2xx,
			errors: samples.errors,
			timeouts: samples.timeouts,
			statuses: { ...samples.statusCounts }
		},
		throughput: {
			requestsPerSec: seconds === null ? null : round1(total / seconds),
			okPerSec: seconds === null ? null : round1(ok / seconds)
		},
		reasons
	};
}

/**
 * @param {string} name
 * @param {string} reason
 */
export function skipped(name, reason) {
	return { name, status: 'SKIPPED', reasons: [reason] };
}

/**
 * Overall verdict: every executed scenario passed. SKIPPED does not fail the run, but at least one
 * scenario must have executed.
 * @param {ReadonlyArray<{ status: string }>} results
 */
export function overallPass(results) {
	const ran = results.filter((r) => r.status !== 'SKIPPED');
	return ran.length > 0 && ran.every((r) => r.status === 'PASS');
}
