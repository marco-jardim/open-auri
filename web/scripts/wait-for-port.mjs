// Waits until a local TCP port accepts connections (used by playwright.config.ts so the second
// preview server starts only after the first one has finished `npm run build`; otherwise its
// wrangler watcher sees the build rewrite .svelte-kit/cloudflare mid-run and reloads or crashes).
import { connect } from 'node:net';

const port = Number(process.argv[2]);
const timeoutMs = Number(process.argv[3] ?? 300_000);
if (!Number.isInteger(port) || port <= 0) {
	console.error('Usage: node scripts/wait-for-port.mjs <port> [timeoutMs]');
	process.exit(2);
}

const deadline = Date.now() + timeoutMs;
// The preview may listen on IPv4 or IPv6 only (on Windows `localhost` often resolves to ::1).
const HOSTS = ['127.0.0.1', '::1', 'localhost'];

/** Resolves when `host:port` accepts a connection, rejects on any error. */
function probe(host) {
	return new Promise((resolve, reject) => {
		const socket = connect({ port, host });
		socket.once('connect', () => {
			socket.end();
			resolve(host);
		});
		socket.once('error', (error) => {
			socket.destroy();
			reject(error);
		});
		// A host that neither connects nor refuses must not stall the other probes' retries.
		socket.setTimeout(2000, () => {
			socket.destroy();
			reject(new Error(`connect to ${host}:${port} timed out`));
		});
	});
}

async function attempt() {
	try {
		// Succeeds on the first host that connects; rejects only when every host failed.
		await Promise.any(HOSTS.map(probe));
		process.exit(0);
	} catch {
		// Every host refused (or failed to resolve): retry below.
	}
	if (Date.now() > deadline) {
		console.error(`Port ${port} did not open within ${timeoutMs} ms on ${HOSTS.join(', ')}`);
		process.exit(1);
	}
	setTimeout(attempt, 500);
}

attempt();
