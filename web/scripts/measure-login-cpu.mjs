#!/usr/bin/env node
// Login cost measurement for PF3 (budget: ≤ 200 ms of CPU per sign-in on the Worker).
//
// Why a script against `wrangler dev` and not a timer inside the Vitest pool: workerd freezes
// Date.now()/performance.now() while JavaScript runs (they only advance across I/O), so a timer
// around `auth.api.signInEmail` inside the pool cannot see the scrypt work. Here the clock is
// Node's, outside workerd: the wall time of one sign-in request includes the password hash (the
// dominant CPU cost), the session write to the local D1 and HTTP overhead, so it is an UPPER
// bound of the CPU time. As a lower bound the script also times the bare hash in Node with the
// same parameters (scrypt N=16384, r=8, p=5, 64 bytes).
//
// Usage (the e2e auth-flow server: `npm run -w web preview:auth-flow`, port 4174, capture mode):
//   node web/scripts/measure-login-cpu.mjs [--url http://localhost:4174] [--runs 8]
//   node web/scripts/measure-login-cpu.mjs --url <url> --email <verified e-mail> --password <pw>
// Without --email it creates and verifies a throwaway user through the dev mailbox, which only
// exists with EMAIL_TRANSPORT=capture on localhost. Sign-ins are spaced 3.5 s apart to stay under
// the sign-in limit (3 per 10 s per IP + e-mail; 10 per 5 min per e-mail), so --runs ≤ 9.
// Nothing here prints the password or tokens.
import { scryptSync, randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

const BUDGET_MS = 200;
const DUMMY_TURNSTILE_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
const SPACING_MS = 3500;

const { values } = parseArgs({
	options: {
		url: { type: 'string', default: 'http://localhost:4174' },
		runs: { type: 'string', default: '8' },
		email: { type: 'string' },
		password: { type: 'string' }
	}
});

const origin = new URL(values.url).origin;
const runs = Math.min(9, Math.max(2, Number.parseInt(values.runs, 10) || 8));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function headers() {
	return {
		'content-type': 'application/json',
		origin,
		// A fresh address per request: the per-IP window (3 per 10 s) must not throttle the sample;
		// the per-address limit (10 per 5 min) still bounds --runs.
		'cf-connecting-ip': `10.${randomBytes(3).join('.')}`,
		'x-turnstile-token': DUMMY_TURNSTILE_TOKEN
	};
}

async function post(path, body) {
	return fetch(`${origin}/api/auth${path}`, {
		method: 'POST',
		headers: headers(),
		body: JSON.stringify(body),
		redirect: 'manual'
	});
}

async function createVerifiedUser() {
	const email = `cpu+${crypto.randomUUID()}@example.test`;
	const password = `measure ${randomBytes(9).toString('base64url')}`;
	const signUp = await post('/sign-up/email', { name: '', email, password });
	if (signUp.status !== 200) throw new Error(`sign-up failed with HTTP ${signUp.status}`);
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const response = await fetch(`${origin}/api/dev/mailbox?to=${encodeURIComponent(email)}`);
		if (response.status === 404) {
			throw new Error('no dev mailbox: start the server with EMAIL_TRANSPORT=capture on localhost');
		}
		const { messages } = await response.json();
		const link = /https?:\/\/\S+/.exec(messages?.[0]?.text ?? '')?.[0];
		if (link) {
			const verified = await fetch(link, { redirect: 'manual' });
			if (verified.status >= 400)
				throw new Error(`verification failed with HTTP ${verified.status}`);
			return { email, password };
		}
		await sleep(250);
	}
	throw new Error('the verification e-mail never arrived');
}

function stats(samples) {
	const sorted = [...samples].sort((a, b) => a - b);
	const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
	return {
		min: sorted[0],
		median: pick(0.5),
		p95: pick(0.95),
		max: sorted[sorted.length - 1]
	};
}

const fmt = (ms) => `${ms.toFixed(1)} ms`;

function hashBaseline(times = 5) {
	const samples = [];
	for (let i = 0; i < times; i += 1) {
		const start = performance.now();
		scryptSync('correct horse battery staple'.normalize('NFKC'), randomBytes(16), 64, {
			N: 16384,
			r: 8,
			p: 5,
			maxmem: 64 * 1024 * 1024
		});
		samples.push(performance.now() - start);
	}
	return stats(samples);
}

async function main() {
	const user =
		values.email && values.password
			? { email: values.email, password: values.password }
			: await createVerifiedUser();

	const samples = [];
	for (let run = 0; run <= runs; run += 1) {
		if (run > 0) await sleep(SPACING_MS);
		const start = performance.now();
		const response = await post('/sign-in/email', { email: user.email, password: user.password });
		const elapsed = performance.now() - start;
		await response.arrayBuffer();
		if (response.status !== 200)
			throw new Error(`sign-in ${run} failed with HTTP ${response.status}`);
		// Run 0 warms the isolate (module load, first D1 connection) and is not counted.
		if (run > 0) samples.push(elapsed);
	}

	const login = stats(samples);
	const hash = hashBaseline();
	console.log(`Sign-in against ${origin} (${samples.length} timed requests, 1 warm-up):`);
	console.log(
		`  wall time per request: min ${fmt(login.min)} · median ${fmt(login.median)} · ` +
			`p95 ${fmt(login.p95)} · max ${fmt(login.max)}`
	);
	console.log(
		`  bare scrypt in Node (lower bound): median ${fmt(hash.median)} · max ${fmt(hash.max)}`
	);
	const verdict = login.median <= BUDGET_MS ? 'within' : 'OVER';
	console.log(`  PF3 budget ${BUDGET_MS} ms: median request is ${verdict} budget.`);
	console.log(
		'  Note: local wall time over-approximates Worker CPU time (it adds D1 and HTTP I/O); ' +
			'confirm in production with the Workers CPU-time metric.'
	);
	if (verdict === 'OVER') process.exitCode = 1;
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : 'measurement failed');
	process.exitCode = 1;
});
