// Load runner of T5.6 (staging only). Uses the autocannon programmatic API; install it in the web
// workspace first (`npm i -D autocannon@^8.0.0`). The runner refuses production origins.
//
//   node web/tests/load/run.mjs --origin <url> [--scenario feed|curve-page|rankings|publish|all]
//     [--duration 20] [--connections 20] [--rate <rps>] [--curve <lineageId>]
//     [--envelope <file>] [--visibility private] [--amount 20]
//
// Prints one JSON summary on stdout. Exit codes: 0 every executed scenario passed, 1 a scenario
// failed or the run broke, 2 usage error or refused origin. The session cookie
// (`LOAD_SESSION_COOKIE`) is sent only on the publish scenario and never printed.
// See docs/operacao/capacidade.md.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
	PUBLISH_MAX_CONNECTIONS,
	TARGETS,
	USAGE,
	UsageError,
	assertSafeOrigin,
	buildScenario,
	evaluate,
	extractEnvelope,
	overallPass,
	parseArgs,
	pickLineageId,
	skipped
} from './scenarios.mjs';

const REQUEST_TIMEOUT_S = 10;

/** @returns {Promise<Function>} */
async function loadAutocannon() {
	try {
		const mod = await import('autocannon');
		return mod.default;
	} catch {
		throw new UsageError(
			'autocannon não está instalado; rode `npm i -D autocannon@^8.0.0` no workspace web'
		);
	}
}

/**
 * Picks a lineage from the public feed when `--curve` was not given.
 * @param {string} origin
 * @returns {Promise<string | null>}
 */
async function discoverCurve(origin) {
	try {
		const res = await fetch(`${origin}/api/v1/feed?limit=5`, {
			headers: { accept: 'application/json' },
			redirect: 'manual'
		});
		if (!res.ok) return null;
		return pickLineageId(await res.json());
	} catch {
		// Network or JSON failure: the caller skips curve-page with an explicit reason.
		return null;
	}
}

/**
 * @param {string} file
 * @returns {Promise<Record<string, unknown>>}
 */
async function readEnvelope(file) {
	let text;
	try {
		text = await readFile(file, 'utf8');
	} catch {
		throw new UsageError('--envelope: arquivo não encontrado ou ilegível');
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new UsageError('--envelope: o arquivo não é JSON válido');
	}
	return extractEnvelope(parsed);
}

/**
 * @param {string} name
 * @param {import('./scenarios.mjs').LoadArgs} args
 * @param {string} origin
 * @param {Record<string, string | undefined>} env
 */
async function prepare(name, args, origin, env) {
	if (name === 'curve-page') {
		const curve = args.curve ?? (await discoverCurve(origin));
		if (curve === null) {
			throw new UsageError('não foi possível achar uma linhagem pública pelo feed; passe --curve');
		}
		return buildScenario(name, { origin, curve });
	}
	if (name === 'publish') {
		if (args.envelope === null) {
			throw new UsageError('publish exige --envelope com um envelope S5 aprovado no gate');
		}
		const token = env.LOAD_TURNSTILE_TOKEN;
		if (token !== undefined && /[\r\n\0]/.test(token)) {
			throw new UsageError('LOAD_TURNSTILE_TOKEN inválido');
		}
		return buildScenario(name, {
			origin,
			cookie: env.LOAD_SESSION_COOKIE,
			turnstileToken: token,
			envelope: await readEnvelope(args.envelope),
			visibility: args.visibility
		});
	}
	return buildScenario(name, { origin });
}

/**
 * @param {Function} autocannon
 * @param {string} origin
 * @param {import('./scenarios.mjs').ScenarioRequest} scenario
 * @param {import('./scenarios.mjs').LoadArgs} args
 */
async function runScenario(autocannon, origin, scenario, args) {
	/** @type {Record<string, number>} */
	const statusCounts = {};
	/** @type {number[]} */
	const okLatenciesMs = [];
	const write = scenario.kind === 'write';
	/** @type {Record<string, unknown>} */
	const options = {
		url: `${origin}${scenario.path}`,
		method: scenario.method,
		headers: scenario.headers,
		connections: write ? Math.min(args.connections, PUBLISH_MAX_CONNECTIONS) : args.connections,
		timeout: REQUEST_TIMEOUT_S
	};
	if (scenario.body !== undefined) options.body = scenario.body;
	// Publication is bounded by the daily quota, so it runs a fixed number of requests.
	if (write) options.amount = args.amount;
	else options.duration = args.duration;
	if (args.rate !== null) options.overallRate = args.rate;

	const started = performance.now();
	/** @type {{ errors?: number, timeouts?: number }} */
	const result = await new Promise((resolve, reject) => {
		const instance = autocannon(options, (/** @type {unknown} */ err, /** @type {never} */ res) => {
			if (err) reject(err instanceof Error ? err : new Error(String(err)));
			else resolve(res);
		});
		instance.on(
			'response',
			(
				/** @type {unknown} */ _client,
				/** @type {number} */ statusCode,
				/** @type {number} */ _bytes,
				/** @type {number} */ responseTime
			) => {
				const key = String(statusCode);
				statusCounts[key] = (statusCounts[key] ?? 0) + 1;
				if (statusCode >= 200 && statusCode < 300) okLatenciesMs.push(responseTime);
			}
		);
	});
	const elapsedMs = performance.now() - started;
	// autocannon counts timeouts inside `errors`.
	const timeouts = result.timeouts ?? 0;
	const errors = Math.max(0, (result.errors ?? 0) - timeouts);
	return evaluate(scenario, { okLatenciesMs, statusCounts, errors, timeouts, elapsedMs });
}

/**
 * @param {readonly string[]} argv
 * @param {Record<string, string | undefined>} env
 * @param {{ log: (s: string) => void, error: (s: string) => void }} [io]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, env, io = console) {
	let args;
	let origin;
	try {
		args = parseArgsOrHelp(argv);
		if (args === null) {
			io.log(USAGE);
			return 0;
		}
		origin = assertSafeOrigin(args.origin);
	} catch (err) {
		if (err instanceof UsageError) {
			io.error(err.message);
			io.error(USAGE);
			return 2;
		}
		throw err;
	}

	const explicit = args.scenarios.length === 1;
	const startedAt = new Date().toISOString();
	/** @type {Array<{ status: string }>} */
	const results = [];
	/** @type {Function | null} */
	let autocannon = null;
	for (const name of args.scenarios) {
		let scenario;
		try {
			scenario = await prepare(name, args, origin, env);
			autocannon ??= await loadAutocannon();
		} catch (err) {
			if (!(err instanceof UsageError)) throw err;
			if (explicit) {
				io.error(err.message);
				return 2;
			}
			results.push(skipped(name, err.message));
			continue;
		}
		results.push(await runScenario(autocannon, origin, scenario, args));
	}

	const pass = overallPass(results);
	const summary = {
		tool: 'open-auri-load/1',
		origin,
		startedAt,
		finishedAt: new Date().toISOString(),
		config: {
			duration: args.duration,
			connections: args.connections,
			rate: args.rate,
			publish: {
				amount: args.amount,
				connections: Math.min(args.connections, PUBLISH_MAX_CONNECTIONS),
				visibility: args.visibility
			},
			targetsP95Ms: TARGETS
		},
		pass,
		scenarios: results
	};
	io.log(JSON.stringify(summary, null, 2));
	return pass ? 0 : 1;
}

/**
 * @param {readonly string[]} argv
 * @returns {import('./scenarios.mjs').LoadArgs | null} null when only help was asked
 */
function parseArgsOrHelp(argv) {
	const args = parseArgs(argv);
	return args.help ? null : args;
}

const invokedDirectly =
	process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
	main(process.argv.slice(2), process.env).then(
		(code) => {
			process.exitCode = code;
		},
		(err) => {
			console.error(err instanceof Error ? err.message : String(err));
			process.exitCode = 1;
		}
	);
}
