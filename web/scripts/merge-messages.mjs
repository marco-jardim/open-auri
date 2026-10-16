import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('../', import.meta.url));
const locales = ['pt-BR', 'en-US'];

function readMessages(path) {
	let messages;
	try {
		messages = JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		throw new Error(`Cannot read valid JSON: ${path}`);
	}
	if (!messages || typeof messages !== 'object' || Array.isArray(messages)) {
		throw new Error(`Expected a JSON object: ${path}`);
	}
	for (const [key, value] of Object.entries(messages)) {
		if (typeof value !== 'string') throw new Error(`Non-string message: ${key} in ${path}`);
	}
	return messages;
}

function main() {
	const args = process.argv.slice(2);
	const task = args.shift();
	if (
		!task ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(task) ||
		args.some((arg) => arg !== '--no-compile')
	) {
		throw new Error('Usage: node web/scripts/merge-messages.mjs <TASK-ID> [--no-compile]');
	}
	const plans = locales.map((locale) => {
		const target = join(web, 'messages', `${locale}.json`);
		const staging = join(web, 'messages', '_staging', `${task}.${locale}.json`);
		return { target, staging, current: readMessages(target), additions: readMessages(staging) };
	});
	const keys = plans.map(({ additions }) => Object.keys(additions).sort());
	if (JSON.stringify(keys[0]) !== JSON.stringify(keys[1])) {
		throw new Error('Staging keys must match in pt-BR and en-US');
	}
	for (const { current, additions } of plans) {
		for (const key of Object.keys(additions)) {
			if (Object.hasOwn(current, key)) throw new Error(`Message key already present: ${key}`);
		}
	}
	// Validate both locales before changing either file.
	for (const { target, current, additions } of plans) {
		const merged = { ...current, ...additions };
		const sorted = Object.fromEntries(
			Object.keys(merged)
				.sort()
				.map((key) => [key, merged[key]])
		);
		writeFileSync(target, JSON.stringify(sorted, null, '\t') + '\n', 'utf8');
	}
	for (const { staging } of plans) unlinkSync(staging);
	if (!args.includes('--no-compile')) {
		// Invoke npm's JS entry point rather than a .cmd shell on Windows.
		const npm =
			process.env.npm_execpath ??
			join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
		const result = spawnSync(
			process.execPath,
			[
				npm,
				'exec',
				'--',
				'@inlang/paraglide-js',
				'compile',
				'--project',
				'./project.inlang',
				'--outdir',
				'./src/lib/paraglide'
			],
			{ cwd: web, stdio: 'inherit' }
		);
		if (result.error || result.status !== 0) {
			throw new Error(
				'Messages merged, but Paraglide compilation failed; rerun the compile command'
			);
		}
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : 'Message merge failed');
	process.exitCode = 1;
}
