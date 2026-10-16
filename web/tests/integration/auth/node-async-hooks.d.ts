// The integration program has no @types/node (see node-crypto.d.ts), but
// web/src/lib/server/auth/emails.ts uses AsyncLocalStorage (nodejs_compat). Only what it uses.
declare module 'node:async_hooks' {
	export class AsyncLocalStorage<T> {
		getStore(): T | undefined;
		run<R>(store: T, callback: () => R): R;
	}
}
