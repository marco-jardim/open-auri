// Runs before every integration test file: applies web/migrations to the local D1 emulation.
// applyD1Migrations records what it applied, so repeated runs only add new migrations.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
