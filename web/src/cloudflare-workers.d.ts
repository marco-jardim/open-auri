// Kit 3's adapter-cloudflare no longer passes `platform` to `server.respond`: bindings come from the
// `cloudflare:workers` module (virtualized by the adapter in dev/preview). hooks.server.ts imports
// it to rebuild `event.platform` for the rest of the app.
declare module 'cloudflare:workers' {
	export const env: import('./lib/server/types.ts').Env;
	export function waitUntil(promise: Promise<unknown>): void;
}
