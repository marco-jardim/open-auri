import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

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
//
// Staging (T5.T): the deployed staging Worker. Its origin comes ONLY from the environment (the
// workers.dev subdomain is sensitive and never versioned). With STAGING_ORIGIN set the config has
// a single project, `staging` (tests/e2e/staging.spec.ts), and neither the local servers nor the
// local D1 setup start:
//   $env:STAGING_ORIGIN = '<staging origin>'; npx playwright test --project=staging
// Without STAGING_ORIGIN the `staging` project does not exist (`--project=staging` stops before
// any server starts) and staging.spec.ts is ignored by the local projects (it also skips itself).
const AUTH_FLOW_SPECS = [
	'**/auth.spec.ts',
	'**/account.spec.ts',
	'**/social.spec.ts',
	'**/community.spec.ts'
];
// Timing budgets are measured after every other project has finished, so 8 parallel browsers do
// not steal the main thread from the page under measurement.
// Caveat (issue #24): perf-desktop and perf-mobile depend on FUNCTIONAL_PROJECTS, and Playwright
// does not run a project when any test of a dependency fails (after retries). So one functional
// failure silently drops every perf budget: the report counts them as "did not run", not as
// failures, and the run fails only for the functional test. Budgets are checked only by a green
// functional run; to measure them on their own, run the perf projects in a separate invocation
// that skips the dependencies (CI has no such step today; `npm run test:e2e` runs everything):
//   npx playwright test --project=perf-desktop --project=perf-mobile --no-deps
const PERF_SPECS = ['**/perf.spec.ts'];
const STAGING_SPECS = ['**/staging.spec.ts'];
const FUNCTIONAL_PROJECTS = ['desktop', 'mobile', 'auth-flow'];
const STAGING_ORIGIN = process.env.STAGING_ORIGIN;

const LOCAL_PROJECTS: PlaywrightTestConfig['projects'] = [
	{
		name: 'desktop',
		testIgnore: [...AUTH_FLOW_SPECS, ...PERF_SPECS, ...STAGING_SPECS],
		use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }
	},
	{
		name: 'mobile',
		testIgnore: [...AUTH_FLOW_SPECS, ...PERF_SPECS, ...STAGING_SPECS],
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
];

const STAGING_PROJECTS: PlaywrightTestConfig['projects'] = [
	{
		name: 'staging',
		testMatch: STAGING_SPECS,
		use: {
			...devices['Desktop Chrome'],
			viewport: { width: 1440, height: 900 },
			baseURL: STAGING_ORIGIN
		}
	}
];

const LOCAL_SETUP: Pick<PlaywrightTestConfig, 'globalSetup' | 'webServer'> = {
	globalSetup: './tests/e2e/global-setup.ts',
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
	]
};

export default defineConfig({
	testDir: 'tests/e2e',
	...(STAGING_ORIGIN ? {} : LOCAL_SETUP),
	// Staging rate limits key on the runner's single public IP: stay gentle there.
	workers: STAGING_ORIGIN ? 2 : '50%',
	retries: process.env.CI ? 2 : 0,
	// Screenshot baselines exist only for win32 (fonts and anti-aliasing differ per OS). Elsewhere
	// (the Linux CI runner) every state spec still runs all its behavioural assertions and only
	// the `toHaveScreenshot` comparisons are skipped (QG round 2, M1).
	ignoreSnapshots: process.platform !== 'win32',
	use: { baseURL: 'http://localhost:4173', trace: 'on-first-retry', locale: 'pt-BR' },
	projects: STAGING_ORIGIN ? STAGING_PROJECTS : LOCAL_PROJECTS
});
