// Types `env` from `cloudflare:workers` (and `cloudflare:test`) with the app's hand-written Env,
// plus the test-only binding injected by the `integration` project in vite.config.ts.
import type { D1Migration } from 'cloudflare:test';
import type { Env as AppEnv } from '#lib/server/types.ts';

declare global {
	namespace Cloudflare {
		interface Env extends AppEnv {
			TEST_MIGRATIONS: D1Migration[];
		}
	}
}

export {};
