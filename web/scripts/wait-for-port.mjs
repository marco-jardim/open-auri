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

function attempt() {
	const socket = connect({ port, host: '127.0.0.1' });
	socket.once('connect', () => {
		socket.end();
		process.exit(0);
	});
	socket.once('error', () => {
		socket.destroy();
		if (Date.now() > deadline) {
			console.error(`Port ${port} did not open within ${timeoutMs} ms`);
			process.exit(1);
		}
		setTimeout(attempt, 500);
	});
}

attempt();
