import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Jobs Worker tests run inside workerd with the bindings of the rendered wrangler.jsonc (top level
// = production shape; every resource is emulated locally, nothing remote). D1 migrations are the
// web's (shared database), applied by test/setup/apply-migrations.ts.
const MIGRATIONS_DIR = fileURLToPath(new URL('../../web/migrations', import.meta.url));

// Test-only keyring: overrides any .dev.vars value so no real secret reaches a test.
const JOBS_TEST_SECRETS = {
  ACCESS_LOG_KEY: 'jobs-test-only-access-log-key-0000000000000000',
};

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      remoteBindings: false,
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: existsSync(MIGRATIONS_DIR) ? await readD1Migrations(MIGRATIONS_DIR) : [],
          ...JOBS_TEST_SECRETS,
        },
      },
    })),
  ],
  test: {
    name: 'jobs',
    expect: { requireAssertions: true },
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup/apply-migrations.ts'],
  },
});
