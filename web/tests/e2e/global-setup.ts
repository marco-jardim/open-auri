// Playwright global setup: renders wrangler.jsonc and applies the D1 migrations to both local
// databases the e2e servers use (the default `.wrangler/state` of :4173 and the separate
// AUTH_FLOW_PERSIST directory of the auth-flow server on :4174). Local only (`--local`), never a
// remote database. Output is inherited so a failing migration is visible.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const AUTH_FLOW_PERSIST = '.wrangler/e2e-auth-flow';

const WEB_DIR = fileURLToPath(new URL('../../', import.meta.url));

function run(command: string, args: string[]): void {
	const result = spawnSync(command, args, {
		cwd: WEB_DIR,
		stdio: 'inherit',
		shell: process.platform === 'win32',
		// Non-interactive: wrangler applies without the confirmation prompt.
		env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }
	});
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(' ')} failed (exit ${String(result.status)})`);
	}
}

export default function globalSetup(): void {
	run('node', ['../tools/render-wrangler.mjs', 'wrangler.template.jsonc', 'wrangler.jsonc']);
	run('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local']);
	run('npx', [
		'wrangler',
		'd1',
		'migrations',
		'apply',
		'DB',
		'--local',
		'--persist-to',
		AUTH_FLOW_PERSIST
	]);
}
