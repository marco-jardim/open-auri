import { defineConfig, devices } from '@playwright/test';

// Two servers over the same build:
//   - :4173 `npm run preview`: the real .env flags (sign-up closed, Resend transport). Every spec
//     except the auth-flow ones runs here (auth-pages.spec.ts checks the closed sign-up page).
//   - :4174 `npm run preview:auth-flow`: local test mode for auth.spec.ts / account.spec.ts, via
//     `wrangler dev --var` overrides (they beat both wrangler.jsonc vars and .dev.vars secrets):
//     SIGNUP_ENABLED=true, EMAIL_TRANSPORT=capture (dev mailbox in D1, GET /api/dev/mailbox),
//     PUBLIC_ORIGIN=http://localhost:4174 (capture and the local Turnstile stub are refused on any
//     other origin) and Cloudflare's always-pass test secret. Its D1 lives in its own
//     --persist-to directory. The client bundle keeps the .env site key: the specs stub the
//     widget script, which hands out the dummy token the local stub accepts.
// Servers start one after the other (in array order), so only the first one builds.
// tests/e2e/global-setup.ts applies the local D1 migrations to both databases.
const AUTH_FLOW_SPECS = [
	'**/auth.spec.ts',
	'**/account.spec.ts',
	'**/social.spec.ts',
	'**/community.spec.ts'
];
// Timing budgets are measured after every other project has finished, so 8 parallel browsers do
// not steal the main thread from the page under measurement.
const PERF_SPECS = ['**/perf.spec.ts'];
const FUNCTIONAL_PROJECTS = ['desktop', 'mobile', 'auth-flow'];

export default defineConfig({
	testDir: 'tests/e2e',
	globalSetup: './tests/e2e/global-setup.ts',
	workers: '50%',
	retries: process.env.CI ? 2 : 0,
	use: { baseURL: 'http://localhost:4173', trace: 'on-first-retry', locale: 'pt-BR' },
	webServer: [
		{
			command: 'npm run build && npm run preview',
			port: 4173,
			reuseExistingServer: !process.env.CI,
			timeout: 180000
		},
		{
			// Starts after the first server is listening, i.e. after its build has finished.
			command: 'node scripts/wait-for-port.mjs 4173 && npm run preview:auth-flow',
			port: 4174,
			reuseExistingServer: !process.env.CI,
			timeout: 120000
		}
	],
	projects: [
		{
			name: 'desktop',
			testIgnore: [...AUTH_FLOW_SPECS, ...PERF_SPECS],
			use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }
		},
		{
			name: 'mobile',
			testIgnore: [...AUTH_FLOW_SPECS, ...PERF_SPECS],
			use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } }
		},
		{
			// Accounts, mail and rate limits are server state: one browser profile is enough.
			name: 'auth-flow',
			testMatch: AUTH_FLOW_SPECS,
			use: {
				...devices['Desktop Chrome'],
				viewport: { width: 1440, height: 900 },
				baseURL: 'http://localhost:4174'
			}
		},
		{
			name: 'perf-desktop',
			testMatch: PERF_SPECS,
			dependencies: FUNCTIONAL_PROJECTS,
			use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }
		},
		{
			name: 'perf-mobile',
			testMatch: PERF_SPECS,
			dependencies: FUNCTIONAL_PROJECTS,
			use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } }
		}
	]
});
