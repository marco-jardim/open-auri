// Offline tests of the T5.6 load runner: `node --test web/tests/load/run.test.mjs`.
// Nothing here opens a socket: only the pure helpers and the early exits of `main` are exercised.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { main } from './run.mjs';
import {
	MAX_FAILURE_RATIO,
	PUBLISH_DEFAULT_AMOUNT,
	TARGETS,
	TURNSTILE_TEST_TOKEN,
	UsageError,
	assertSafeOrigin,
	buildScenario,
	evaluate,
	extractEnvelope,
	overallPass,
	parseArgs,
	percentile,
	pickLineageId,
	skipped
} from './scenarios.mjs';

const STAGING = 'https://open-auri-web-staging.example.workers.dev';

describe('parseArgs', () => {
	it('applies the defaults', () => {
		const args = parseArgs(['--origin', 'http://localhost:4173']);
		assert.equal(args.origin, 'http://localhost:4173');
		assert.deepEqual(args.scenarios, ['feed', 'curve-page', 'rankings', 'publish']);
		assert.equal(args.duration, 20);
		assert.equal(args.connections, 20);
		assert.equal(args.rate, null);
		assert.equal(args.curve, null);
		assert.equal(args.envelope, null);
		assert.equal(args.visibility, 'private');
		assert.equal(args.amount, PUBLISH_DEFAULT_AMOUNT);
		assert.equal(args.help, false);
	});

	it('reads --flag value and --flag=value forms', () => {
		const args = parseArgs([
			`--origin=${STAGING}`,
			'--scenario',
			'curve-page',
			'--duration=30',
			'--connections',
			'5',
			'--curve',
			'lin_AbC-123',
			'--rate',
			'40'
		]);
		assert.deepEqual(args.scenarios, ['curve-page']);
		assert.equal(args.duration, 30);
		assert.equal(args.connections, 5);
		assert.equal(args.curve, 'lin_AbC-123');
		assert.equal(args.rate, 40);
	});

	it('accepts --help without --origin', () => {
		assert.equal(parseArgs(['--help']).help, true);
	});

	const bad = [
		[[], /--origin é obrigatório/],
		[['--origin'], /precisa de um valor/],
		[['--origin', '--scenario', 'feed'], /precisa de um valor/],
		[['--origin', 'http://localhost', '--scenario', 'login'], /--scenario inválido/],
		[['--origin', 'http://localhost', '--duration', '0'], /entre 1 e 300/],
		[['--origin', 'http://localhost', '--duration', '2.5'], /inteiro/],
		[['--origin', 'http://localhost', '--connections', '101'], /entre 1 e 100/],
		[['--origin', 'http://localhost', '--amount', '31'], /entre 1 e 30/],
		[['--origin', 'http://localhost', '--curve', '../admin'], /--curve/],
		[['--origin', 'http://localhost', '--visibility', 'secret'], /--visibility/],
		[['--origin', 'http://localhost', '--bogus', '1'], /desconhecida/],
		[['--origin', 'http://localhost', '--origin', 'http://localhost'], /repetida/],
		[['--origin', 'http://localhost', 'feed'], /inesperado/],
		[['--help=1'], /não recebe valor/]
	];
	for (const [argv, message] of bad) {
		it(`refuses ${JSON.stringify(argv)}`, () => {
			assert.throws(
				() => parseArgs(/** @type {string[]} */ (argv)),
				(err) => {
					assert.ok(err instanceof UsageError);
					assert.match(err.message, /** @type {RegExp} */ (message));
					return true;
				}
			);
		});
	}
});

describe('assertSafeOrigin', () => {
	const allowed = [
		['http://localhost:4173', 'http://localhost:4173'],
		['http://127.0.0.1:8787/', 'http://127.0.0.1:8787'],
		['http://[::1]:5173', 'http://[::1]:5173'],
		['https://localhost', 'https://localhost'],
		[`${STAGING}/api/v1/feed`, STAGING],
		['https://OPEN-AURI-WEB-STAGING.example.workers.dev', STAGING]
	];
	for (const [input, expected] of allowed) {
		it(`allows ${input}`, () => {
			assert.equal(assertSafeOrigin(input), expected);
		});
	}

	const refused = [
		['https://open-auri.com', /produção/],
		['https://open-auri.com/', /produção/],
		['http://open-auri.com', /produção/],
		['https://www.open-auri.com', /produção/],
		['https://OPEN-AURI.COM.', /produção/],
		['https://open-auri-web.example.workers.dev', /só o Worker de staging/],
		['https://workers.dev', /recusado/],
		['https://staging.workers.dev', /só o Worker de staging/],
		['http://open-auri-web-staging.example.workers.dev', /exige https/],
		['https://example.com', /staging em workers.dev ou localhost/],
		['https://localhost.example.com', /staging em workers.dev ou localhost/],
		['https://open-auri-web-staging.example.workers.dev.evil.test', /staging em workers.dev/],
		['http://10.0.0.5:8787', /staging em workers.dev ou localhost/],
		['ftp://localhost', /http ou https/],
		['https://user:pass@localhost', /credenciais/],
		['not a url', /URL válida/]
	];
	for (const [input, message] of refused) {
		it(`refuses ${input}`, () => {
			assert.throws(
				() => assertSafeOrigin(/** @type {string} */ (input)),
				(err) => {
					assert.ok(err instanceof UsageError);
					assert.match(err.message, /** @type {RegExp} */ (message));
					return true;
				}
			);
		});
	}
});

describe('buildScenario', () => {
	const envelope = { format: 'open-auri/preset@1', name: 'x' };

	it('builds the cached reads without credentials or spoofed IP headers', () => {
		for (const name of ['feed', 'rankings']) {
			const s = buildScenario(name, { origin: STAGING });
			assert.equal(s.method, 'GET');
			assert.equal(s.kind, 'read');
			assert.equal(s.targetP95Ms, 300);
			assert.equal(s.headers.cookie, undefined);
			assert.equal(s.headers['cf-connecting-ip'], undefined);
			assert.equal(s.headers['x-forwarded-for'], undefined);
		}
		assert.equal(buildScenario('feed', { origin: STAGING }).path, '/api/v1/feed');
		assert.equal(buildScenario('rankings', { origin: STAGING }).path, '/api/v1/rankings');
	});

	it('builds the curve page and requires a lineage id', () => {
		const s = buildScenario('curve-page', { origin: STAGING, curve: 'abc_123' });
		assert.equal(s.path, '/c/abc_123');
		assert.equal(s.headers.accept, 'text/html');
		assert.throws(() => buildScenario('curve-page', { origin: STAGING }), UsageError);
	});

	it('builds the publication with cookie, origin, json body and the Turnstile test token', () => {
		const s = buildScenario('publish', {
			origin: STAGING,
			cookie: ' session=abc ',
			envelope,
			visibility: 'unlisted'
		});
		assert.equal(s.method, 'POST');
		assert.equal(s.path, '/api/v1/curves');
		assert.equal(s.kind, 'write');
		assert.equal(s.targetP95Ms, 1500);
		assert.equal(s.expectStatus, 201);
		assert.equal(s.headers.origin, STAGING);
		assert.equal(s.headers.cookie, 'session=abc');
		assert.equal(s.headers['content-type'], 'application/json');
		assert.equal(s.headers['x-turnstile-token'], TURNSTILE_TEST_TOKEN);
		assert.deepEqual(JSON.parse(s.body ?? ''), { envelope, visibility: 'unlisted' });
	});

	it('refuses publication without a usable cookie or envelope, or with a production origin', () => {
		assert.throws(
			() => buildScenario('publish', { origin: STAGING, envelope }),
			/LOAD_SESSION_COOKIE/
		);
		assert.throws(
			() => buildScenario('publish', { origin: STAGING, envelope, cookie: 'a=b\r\nx: y' }),
			/LOAD_SESSION_COOKIE inválido/
		);
		assert.throws(() => buildScenario('publish', { origin: STAGING, cookie: 'a=b' }), /--envelope/);
		assert.throws(
			() => buildScenario('publish', { origin: 'https://open-auri.com', cookie: 'a=b', envelope }),
			/produção/
		);
		const big = { format: 'open-auri/preset@1', pad: 'x'.repeat(33 * 1024) };
		assert.throws(
			() => buildScenario('publish', { origin: STAGING, cookie: 'a=b', envelope: big }),
			/32 KiB/
		);
	});

	it('refuses unknown scenarios', () => {
		assert.throws(() => buildScenario('login', { origin: STAGING }), UsageError);
	});
});

describe('extractEnvelope and pickLineageId', () => {
	it('accepts a bare envelope or a request body', () => {
		const env = { format: 'open-auri/preset@1' };
		assert.equal(extractEnvelope(env), env);
		assert.equal(extractEnvelope({ envelope: env, visibility: 'public' }), env);
		assert.throws(() => extractEnvelope([]), UsageError);
		assert.throws(() => extractEnvelope({ format: 'other' }), /format/);
	});

	it('picks the first valid lineage id from a feed page', () => {
		assert.equal(
			pickLineageId({ items: [{ lineage: { id: 'bad id' } }, { lineage: { id: 'L1' } }] }),
			'L1'
		);
		assert.equal(pickLineageId({ items: [] }), null);
		assert.equal(pickLineageId({}), null);
		assert.equal(pickLineageId(null), null);
	});
});

describe('target evaluation', () => {
	const feed = buildScenario('feed', { origin: STAGING });
	const publish = buildScenario('publish', {
		origin: STAGING,
		cookie: 'a=b',
		envelope: { format: 'open-auri/preset@1' }
	});
	/** @param {number} n @param {(i: number) => number} f */
	const series = (n, f) => Array.from({ length: n }, (_, i) => f(i));

	it('computes nearest-rank percentiles', () => {
		const values = series(100, (i) => i + 1);
		assert.equal(percentile(values, 50), 50);
		assert.equal(percentile(values, 95), 95);
		assert.equal(percentile(values, 99), 99);
		assert.equal(percentile([7], 99), 7);
		assert.equal(percentile([], 50), null);
	});

	it('passes a cached read under 300 ms at p95', () => {
		const r = evaluate(feed, {
			okLatenciesMs: series(200, (i) => (i < 190 ? 40 : 250)),
			statusCounts: { 200: 200 },
			errors: 0,
			timeouts: 0,
			elapsedMs: 20_000
		});
		assert.equal(r.status, 'PASS');
		assert.equal(r.latencyMs.p50, 40);
		assert.equal(r.latencyMs.p95, 40);
		assert.equal(r.latencyMs.p99, 250);
		assert.equal(r.requests.total, 200);
		assert.equal(r.requests.non2xx, 0);
		assert.equal(r.throughput.requestsPerSec, 10);
		assert.deepEqual(r.reasons, []);
	});

	it('fails a cached read at or above 300 ms at p95', () => {
		const r = evaluate(feed, {
			okLatenciesMs: series(100, () => 300),
			statusCounts: { 200: 100 },
			errors: 0,
			timeouts: 0,
			elapsedMs: 1000
		});
		assert.equal(r.status, 'FAIL');
		assert.match(r.reasons.join('\n'), /p95 300 ms >= meta 300 ms/);
	});

	it('ignores fast 429s in the percentiles and fails on too many of them', () => {
		const r = evaluate(feed, {
			okLatenciesMs: series(100, () => 50),
			statusCounts: { 200: 100, 429: 50 },
			errors: 0,
			timeouts: 0,
			elapsedMs: 1000
		});
		assert.equal(r.latencyMs.p95, 50);
		assert.equal(r.requests.non2xx, 50);
		assert.equal(r.status, 'FAIL');
		assert.match(r.reasons.join('\n'), /429\/503/);
	});

	it('tolerates failures up to the configured ratio', () => {
		const r = evaluate(feed, {
			okLatenciesMs: series(95, () => 50),
			statusCounts: { 200: 95, 500: 5 },
			errors: 0,
			timeouts: 0,
			elapsedMs: 1000
		});
		assert.equal(MAX_FAILURE_RATIO, 0.05);
		assert.equal(r.status, 'PASS');
	});

	it('counts socket errors and timeouts as failures', () => {
		const r = evaluate(feed, {
			okLatenciesMs: series(60, () => 50),
			statusCounts: { 200: 60 },
			errors: 3,
			timeouts: 7,
			elapsedMs: 1000
		});
		assert.equal(r.requests.total, 70);
		assert.equal(r.status, 'FAIL');
	});

	it('fails without enough successful samples', () => {
		const r = evaluate(feed, {
			okLatenciesMs: series(10, () => 50),
			statusCounts: { 200: 10 },
			errors: 0,
			timeouts: 0,
			elapsedMs: 1000
		});
		assert.equal(r.status, 'FAIL');
		assert.match(r.reasons.join('\n'), /mínimo 50/);
		const empty = evaluate(feed, {
			okLatenciesMs: [],
			statusCounts: {},
			errors: 0,
			timeouts: 0,
			elapsedMs: 0
		});
		assert.equal(empty.status, 'FAIL');
		assert.equal(empty.latencyMs.p95, null);
		assert.equal(empty.throughput.requestsPerSec, null);
	});

	it('flags redirects (production workers.dev redirects to the custom domain)', () => {
		const r = evaluate(feed, {
			okLatenciesMs: [],
			statusCounts: { 301: 80 },
			errors: 0,
			timeouts: 0,
			elapsedMs: 1000
		});
		assert.match(r.reasons.join('\n'), /redirecionamentos/);
	});

	it('uses 1.5 s for publication', () => {
		assert.equal(TARGETS.publish, 1500);
		const pass = evaluate(publish, {
			okLatenciesMs: series(20, (i) => 600 + i * 40),
			statusCounts: { 201: 20 },
			errors: 0,
			timeouts: 0,
			elapsedMs: 15_000
		});
		assert.equal(pass.status, 'PASS');
		assert.equal(pass.latencyMs.p95, 1320);
		const fail = evaluate(publish, {
			okLatenciesMs: series(20, () => 1600),
			statusCounts: { 201: 20 },
			errors: 0,
			timeouts: 0,
			elapsedMs: 15_000
		});
		assert.equal(fail.status, 'FAIL');
	});

	it('derives the overall verdict from executed scenarios only', () => {
		assert.equal(overallPass([{ status: 'PASS' }, skipped('publish', 'sem cookie')]), true);
		assert.equal(overallPass([{ status: 'PASS' }, { status: 'FAIL' }]), false);
		assert.equal(overallPass([skipped('publish', 'sem cookie')]), false);
		assert.equal(overallPass([]), false);
	});
});

describe('main (early exits, no network)', () => {
	/** @returns {{ io: { log: (s: string) => void, error: (s: string) => void }, out: string[], err: string[] }} */
	const capture = () => {
		/** @type {string[]} */
		const out = [];
		/** @type {string[]} */
		const err = [];
		return { io: { log: (s) => out.push(s), error: (s) => err.push(s) }, out, err };
	};

	it('prints the usage on --help', async () => {
		const c = capture();
		assert.equal(await main(['--help'], {}, c.io), 0);
		assert.match(c.out.join('\n'), /--origin/);
	});

	it('refuses the production origin with exit code 2', async () => {
		const c = capture();
		assert.equal(await main(['--origin', 'https://open-auri.com'], {}, c.io), 2);
		assert.match(c.err.join('\n'), /produção/);
		assert.deepEqual(c.out, []);
	});

	it('refuses an explicit publish without envelope before any request', async () => {
		const c = capture();
		const code = await main(
			['--origin', 'http://localhost:4173', '--scenario', 'publish'],
			{ LOAD_SESSION_COOKIE: 'secret-session-value' },
			c.io
		);
		assert.equal(code, 2);
		assert.match(c.err.join('\n'), /--envelope/);
		assert.doesNotMatch(c.err.join('\n'), /secret-session-value/);
	});
});
