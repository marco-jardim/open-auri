import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

// kB is decimal. Sum individually gzipped HTTP resources, not one concatenated bundle.
export const INITIAL_JS_BUDGET = 250_000;
const defaultOutput = fileURLToPath(new URL('../.svelte-kit/output/', import.meta.url));
/** Versioned per-class targets (spec §5.7), next to this script. */
export const DEFAULT_TARGETS = fileURLToPath(new URL('./budget-targets.json', import.meta.url));
const USAGE =
	'Usage: node web/scripts/check-budgets.mjs [--output <.svelte-kit/output>] [--targets <file.json>] [--by-chunk]';

function byteCount(value, label) {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}`);
	return value;
}

/**
 * A byte count from the targets document: never above the spec ceiling (§5.7, 250 kB gzip). A
 * class may be stricter than the ceiling, never looser, so the JSON cannot raise it.
 */
function targetByteCount(value, label) {
	const bytes = byteCount(value, label);
	if (bytes > INITIAL_JS_BUDGET) {
		throw new Error(`Invalid ${label}: above the ${INITIAL_JS_BUDGET / 1000} kB ceiling`);
	}
	return bytes;
}

/**
 * Validates the targets document: a default ceiling plus route classes. A route pattern is an
 * exact SvelteKit route id, or `<prefix>/**` for the prefix and everything below it. A route
 * may belong to one class only; routes outside every class keep the default ceiling.
 *
 * @param {unknown} value Parsed JSON.
 */
export function parseBudgetTargets(value) {
	const document = object(value, 'budget targets');
	if (document.version !== 1) throw new Error('Invalid budget targets version');
	const defaultBytes = targetByteCount(document.defaultBytes, 'default budget');
	if (!Array.isArray(document.classes)) throw new Error('Invalid budget classes');
	const seenIds = new Set();
	const seenRoutes = new Set();
	const classes = document.classes.map((entry, index) => {
		const item = object(entry, `budget class ${index}`);
		if (typeof item.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(item.id) || seenIds.has(item.id)) {
			throw new Error(`Invalid or duplicate budget class id at ${index}`);
		}
		seenIds.add(item.id);
		const routes = strings(item.routes, `routes of ${item.id}`);
		for (const route of routes) {
			if (!route.startsWith('/') || seenRoutes.has(route)) {
				throw new Error(`Invalid or duplicate budget route: ${route}`);
			}
			seenRoutes.add(route);
		}
		const targetBytes = targetByteCount(item.targetBytes, `target of ${item.id}`);
		const goalBytes =
			item.goalBytes === undefined
				? undefined
				: targetByteCount(item.goalBytes, `goal of ${item.id}`);
		if (goalBytes !== undefined && goalBytes > targetBytes) {
			throw new Error(`Goal above target in ${item.id}`);
		}
		return { id: item.id, targetBytes, goalBytes, routes };
	});
	return { defaultBytes, classes };
}

/** @param {string} [path] Targets JSON; defaults to the versioned file next to this script. */
export function loadBudgetTargets(path = DEFAULT_TARGETS) {
	return parseBudgetTargets(JSON.parse(readFileSync(path, 'utf8')));
}

function matchesRoute(pattern, route) {
	if (!pattern.endsWith('/**')) return pattern === route;
	const base = pattern.slice(0, -3);
	return route === base || route.startsWith(`${base}/`);
}

/**
 * @param {string} route SvelteKit route id.
 * @param {number | ReturnType<typeof parseBudgetTargets>} budget Uniform bytes or targets.
 */
export function budgetForRoute(route, budget) {
	if (typeof budget === 'number') {
		return { classId: null, budgetBytes: byteCount(budget, 'JS budget'), goalBytes: undefined };
	}
	const matched = budget.classes.find((item) =>
		item.routes.some((pattern) => matchesRoute(pattern, route))
	);
	return matched
		? { classId: matched.id, budgetBytes: matched.targetBytes, goalBytes: matched.goalBytes }
		: { classId: null, budgetBytes: budget.defaultBytes, goalBytes: undefined };
}

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
 * @param {number | ReturnType<typeof parseBudgetTargets>} [budget] A uniform byte budget
 *   (isolated tests; 250 kB by default) or the per-class targets the CLI loads from JSON.
 */
export async function measureBudgets(outputDir = defaultOutput, budget = INITIAL_JS_BUDGET) {
	if (typeof budget === 'number') byteCount(budget, 'JS budget');
	else if (!budget || !Array.isArray(budget.classes)) throw new Error('Invalid JS budget');
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
		/** file → manifest label (chunk `name`, else entry `src`, else the manifest key). */
		const labels = new Map();
		function visit(key) {
			if (visited.has(key)) return;
			const chunk = entries.get(key);
			if (!chunk) throw new Error(`Missing static import in Vite manifest: ${key}`);
			visited.add(key);
			if (/\.m?js$/.test(chunk.file)) {
				files.add(chunk.file);
				const name = typeof chunk.name === 'string' && chunk.name ? chunk.name : undefined;
				const src = typeof chunk.src === 'string' && chunk.src ? chunk.src : undefined;
				labels.set(chunk.file, name ?? src ?? key);
			}
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
		const chunks = [];
		for (const file of files) {
			const measured = size(file);
			rawBytes += measured.rawBytes;
			gzipBytes += measured.gzipBytes;
			chunks.push({ file, name: labels.get(file) ?? file, ...measured });
		}
		chunks.sort((a, b) => b.gzipBytes - a.gzipBytes || a.file.localeCompare(b.file, 'en'));
		const { classId, budgetBytes, goalBytes } = budgetForRoute(route.id, budget);
		rows.push({
			route: route.id,
			classId,
			files: [...files].sort(),
			chunks,
			rawBytes,
			gzipBytes,
			budgetBytes,
			goalBytes,
			overBudget: gzipBytes > budgetBytes
		});
	}
	if (!rows.length) throw new Error('No page routes found in generated manifest');
	return rows.sort((a, b) => a.route.localeCompare(b.route, 'en'));
}

/** @param {string[]} args */
export function parseArgs(args) {
	const options = { output: defaultOutput, targets: DEFAULT_TARGETS, byChunk: false };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === '--by-chunk') {
			options.byChunk = true;
			continue;
		}
		if (arg !== '--output' && arg !== '--targets') throw new Error(USAGE);
		const value = args[++index];
		if (value === undefined || value.startsWith('--')) throw new Error(USAGE);
		if (arg === '--output') options.output = value;
		else options.targets = value;
	}
	return options;
}

const kB = (bytes) => (bytes / 1000).toFixed(2);

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const targets = loadBudgetTargets(options.targets);
	const rows = await measureBudgets(options.output, targets);
	console.log('Initial JavaScript per route (gzip; fonts and deferred imports excluded)');
	console.table(
		rows.map((row) => ({
			route: row.route,
			class: row.classId ?? 'default',
			'JS files': row.files.length,
			'raw kB': kB(row.rawBytes),
			'gzip kB': kB(row.gzipBytes),
			'budget kB': row.budgetBytes / 1000,
			'goal kB': row.goalBytes === undefined ? '' : row.goalBytes / 1000,
			status: row.overBudget ? 'FAIL' : 'PASS'
		}))
	);
	if (options.byChunk) {
		for (const row of rows) {
			console.log(`\n${row.route} (${row.classId ?? 'default'}): ${kB(row.gzipBytes)} kB gzip`);
			console.table(
				row.chunks.map((chunk) => ({
					chunk: chunk.name,
					file: chunk.file,
					'raw kB': kB(chunk.rawBytes),
					'gzip kB': kB(chunk.gzipBytes)
				}))
			);
		}
	}
	if (rows.some((row) => row.overBudget)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : 'Budget check failed');
		process.exitCode = 1;
	});
}
