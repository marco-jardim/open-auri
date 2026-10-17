// Test-only bindings injected by vitest.config.ts: the D1 migrations (read in Node) and the empty
// D1 database of the backup → restore round trip (test/phase5.test.ts).
import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      RESTORE_DB: D1Database;
    }
  }
}

export {};
