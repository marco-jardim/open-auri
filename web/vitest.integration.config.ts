import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Separate config on purpose: the SvelteKit adapter plugin of vite.config.ts would replace
// `cloudflare:workers` with its prerender-guarded virtual module inside workerd, and root plugins
// apply to every inline project. Server code under test must not import `$app/*`.
const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));
// Absolute src/lib/ path with forward slashes (Vite alias replacements are joined as strings).
const LIB_DIR = fileURLToPath(new URL('./src/lib/', import.meta.url)).replaceAll('\\', '/');

// Placeholder values for the integration project only (Turnstile's documented always-pass test
// secret; the rest are not real keys). Real secrets live in web/.dev.vars / wrangler secret.
const INTEGRATION_TEST_SECRETS = {
	BETTER_AUTH_SECRET: 'integration-test-only-better-auth-secret-000000',
	RESEND_API_KEY: 're_integration_test_only',
	TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
	IPHASH_PEPPER: 'integration-test-only-iphash-pepper-0000000000',
	ACCESS_LOG_KEY: 'integration-test-only-access-log-key-000000000',
	RESEND_WEBHOOK_SECRET: 'whsec_aW50ZWdyYXRpb24tdGVzdC1vbmx5LXdlYmhvb2s='
};

export default defineConfig({
	resolve: {
		// Same mapping as the "imports" field of web/package.json, made explicit so it does not
		// depend on the pool's resolve conditions.
		alias: [
			{ find: /^#lib$/, replacement: `${LIB_DIR}index.js` },
			{ find: /^#lib\/(.*)$/, replacement: `${LIB_DIR}$1` }
		]
	},
	plugins: [
		// Runs the tests inside workerd with the bindings of the rendered wrangler.jsonc (top
		// level = production shape, all resources emulated locally, nothing remote).
		cloudflareTest(async () => ({
			wrangler: { configPath: './wrangler.jsonc' },
			// The SvelteKit worker only exists after a build; tests exercise server modules
			// directly, so a stub entry point stands in for `main`.
			main: './tests/integration/worker.ts',
			remoteBindings: false,
			miniflare: {
				bindings: {
					// Test-only binding consumed by tests/integration/setup/apply-migrations.ts.
					TEST_MIGRATIONS: existsSync(MIGRATIONS_DIR) ? await readD1Migrations(MIGRATIONS_DIR) : [],
					// Fixed test-only secrets: they override web/.dev.vars so no real secret
					// ever reaches a test.
					...INTEGRATION_TEST_SECRETS
				}
			}
		}))
	],
	test: {
		name: 'integration',
		expect: { requireAssertions: true },
		include: ['tests/integration/**/*.test.ts'],
		setupFiles: ['./tests/integration/setup/apply-migrations.ts']
	}
});
