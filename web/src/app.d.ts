// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { AuthSession, AuthUser, WorkerPlatform } from '#lib/server/types.ts';

declare global {
	namespace App {
		// Hand-written Workers types (module form of @cloudflare/workers-types, no runtime globals);
		// see #lib/server/types.ts.
		interface Platform {
			env: WorkerPlatform['env'];
			ctx: WorkerPlatform['ctx'];
			caches: WorkerPlatform['caches'];
			cf?: WorkerPlatform['cf'];
		}
		// Filled by hooks.server.ts on every request (T3.5); null when signed out.
		interface Locals {
			user: AuthUser | null;
			session: AuthSession | null;
		}
		// interface Error {}
		// interface PageData {}
		// interface PageState {}
	}
}

export {};
