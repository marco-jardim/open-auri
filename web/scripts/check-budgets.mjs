import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

// kB is decimal. Sum individually gzipped HTTP resources, not one concatenated bundle.
export const INITIAL_JS_BUDGET = 250_000;
const defaultOutput = fileURLToPath(new URL('../.svelte-kit/output/', import.meta.url));

function object(value, label) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`Invalid ${label}: expected an object`);
	}
	return value;
}

function strings(value, label) {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
		throw new Error(`Invalid ${label}: expected a string array`);
	}
	return value;
}

/**
 * Use SvelteKit's full generated manifest (including prerendered pages) for route/node
 * membership and Vite's client manifest for the static import graph. Do not execute any
 * server node loaders: those can import application code and depend on runtime bindings.
 * Dynamic imports are excluded, except Kit's mandatory boot imports listed in client.imports
 * (Kit 3 dynamically imports its runtime even on the first navigation).
 *
 * @param {string} [outputDir] The .svelte-kit/output directory, after a successful build.
 * @param {number} [budgetBytes] Override for isolated tests; the CLI always uses 250 kB.
 */
export async function measureBudgets(outputDir = defaultOutput, budgetBytes = INITIAL_JS_BUDGET) {
	if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 0) {
		throw new Error('Invalid JS budget');
	}
	const output = resolve(outputDir);
	const clientDir = join(output, 'client');
	const vitePath = join(clientDir, '.vite', 'manifest.json');
	const vite = object(JSON.parse(readFileSync(vitePath, 'utf8')), 'Vite client manifest');
	const serverPath = join(output, 'server', 'manifest-full.js');
	const serverSource = readFileSync(serverPath, 'utf8');
	const { manifest: generated } = await import(pathToFileURL(serverPath).href);
	const manifest = object(generated, 'SvelteKit manifest');
	const client = object(manifest.client, 'SvelteKit client build (run build:web first)');
	if (typeof client.start !== 'string' || !Array.isArray(manifest.routes)) {
		throw new Error('Invalid SvelteKit routes or client entry');
	}
	if (!Array.isArray(manifest.nodes)) throw new Error('Invalid SvelteKit nodes');
	// Kit wraps loaders in __memo(), so Function#toString cannot recover their imports.
	// Read just the generated nodes array, not arbitrary application modules. A client
	// routing manifest may also contain a nodes array of filenames; it has no imports.
	const nodeArrays = [...serverSource.matchAll(/\bnodes:\s*\[([^\]]*)\]/g)];
	const nodePaths =
		nodeArrays
			.map((match) => [...match[1].matchAll(/import\(\s*['"][^'"]*\/nodes\/(\d+)\.js['"]\s*\)/g)])
			.find((matches) => matches.length > 0) ?? [];
	if (nodePaths.length !== manifest.nodes.length) {
		throw new Error('Cannot resolve generated SvelteKit node loaders');
	}
	const entries = new Map(Object.entries(vite));
	const byFile = new Map();
	for (const [key, value] of entries) {
		const chunk = object(value, `Vite chunk ${key}`);
		if (typeof chunk.file !== 'string') throw new Error(`Missing Vite filename: ${key}`);
		byFile.set(chunk.file, key);
	}
	const bootFiles = [client.start, ...strings(client.imports, 'SvelteKit boot imports')];
	if (client.app !== undefined) {
		if (typeof client.app !== 'string') throw new Error('Invalid SvelteKit app entry');
		bootFiles.push(client.app);
	}
	const sizes = new Map();
	function size(file) {
		let measured = sizes.get(file);
		if (measured) return measured;
		const target = resolve(clientDir, file);
		const local = relative(clientDir, target);
		if (
			file.includes('\\') ||
			file.includes(':') ||
			isAbsolute(file) ||
			isAbsolute(local) ||
			local === '..' ||
			local.startsWith('../') ||
			local.startsWith('..\\')
		) {
			throw new Error(`Client asset escapes build output: ${file}`);
		}
		const source = readFileSync(target);
		measured = { rawBytes: source.byteLength, gzipBytes: gzipSync(source).byteLength };
		sizes.set(file, measured);
		return measured;
	}
	function nodeKey(index) {
		if (!Number.isSafeInteger(index) || index < 0) throw new Error('Invalid route node index');
		const original = nodePaths[index]?.[1];
		if (original === undefined) throw new Error(`Cannot resolve generated route node ${index}`);
		// Full-manifest node indexes can be reindexed. The loader retains the original
		// output filename, which matches the numbered client entry in Vite's manifest.
		const prefix = `${manifest.app_dir ?? '_app'}/immutable/nodes/${original}.`;
		const matches = [...entries].filter(
			([, chunk]) => chunk.file.startsWith(prefix) && chunk.file.endsWith('.js')
		);
		if (matches.length !== 1) throw new Error(`Missing or ambiguous client route node ${index}`);
		return matches[0][0];
	}
	const rows = [];
	for (const route of manifest.routes) {
		if (!route.page) continue; // API endpoints have no initial client JavaScript.
		if (typeof route.id !== 'string' || !Array.isArray(route.page.layouts)) {
			throw new Error('Invalid SvelteKit page route');
		}
		const visited = new Set();
		const files = new Set();
		function visit(key) {
			if (visited.has(key)) return;
			const chunk = entries.get(key);
			if (!chunk) throw new Error(`Missing static import in Vite manifest: ${key}`);
			visited.add(key);
			if (/\.m?js$/.test(chunk.file)) files.add(chunk.file);
			for (const dependency of strings(chunk.imports ?? [], `imports of ${key}`)) {
				visit(dependency);
			}
			// Never follow dynamicImports or assets: PNG/QR modules, workers and fonts
			// are not part of the route's initial static JS dependency closure.
		}
		for (const file of bootFiles) {
			const key = byFile.get(file);
			if (key === undefined) throw new Error(`Missing client boot chunk: ${file}`);
			visit(key);
		}
		for (const index of [...route.page.layouts, route.page.leaf]) {
			if (index !== undefined && index !== null) visit(nodeKey(index));
		}
		let rawBytes = 0;
		let gzipBytes = 0;
		for (const file of files) {
			const measured = size(file);
			rawBytes += measured.rawBytes;
			gzipBytes += measured.gzipBytes;
		}
		rows.push({
			route: route.id,
			files: [...files].sort(),
			rawBytes,
			gzipBytes,
			budgetBytes,
			overBudget: gzipBytes > budgetBytes
		});
	}
	if (!rows.length) throw new Error('No page routes found in generated manifest');
	return rows.sort((a, b) => a.route.localeCompare(b.route, 'en'));
}

async function main() {
	const args = process.argv.slice(2);
	if (args.length && (args.length !== 2 || args[0] !== '--output')) {
		throw new Error('Usage: node web/scripts/check-budgets.mjs [--output <.svelte-kit/output>]');
	}
	const rows = await measureBudgets(args[1] ?? defaultOutput);
	console.log('Initial JavaScript per route (gzip; fonts and deferred imports excluded)');
	console.table(
		rows.map((row) => ({
			route: row.route,
			'JS files': row.files.length,
			'raw kB': (row.rawBytes / 1000).toFixed(2),
			'gzip kB': (row.gzipBytes / 1000).toFixed(2),
			'budget kB': row.budgetBytes / 1000,
			status: row.overBudget ? 'FAIL' : 'PASS'
		}))
	);
	if (rows.some((row) => row.overBudget)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : 'Budget check failed');
		process.exitCode = 1;
	});
}
