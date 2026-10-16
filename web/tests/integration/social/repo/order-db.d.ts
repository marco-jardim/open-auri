// Test-only D1 binding added by vitest.integration.config.ts for migrations.test.ts.
import type { D1Database } from '@cloudflare/workers-types';

declare global {
	namespace Cloudflare {
		interface Env {
			SOCIAL_ORDER_DB: D1Database;
		}
	}
}

export {};
