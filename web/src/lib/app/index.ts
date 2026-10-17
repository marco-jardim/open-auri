// The value export of createClientApp keeps the runtime in the static closure of whatever
// imports this barrel (instrument pages: no load cascade). Chrome and static-route modules import
// `./context.svelte.ts` and `./runtime.ts` directly instead (FUX.2, README "Loading").
export { createClientApp, type ClientApp, type ClientAppOptions } from './client.svelte.ts';
export {
	createAppContext,
	getAppContext,
	setAppContext,
	type AppContext,
	type AppMountOptions,
	type AppRuntimeStatus
} from './context.svelte.ts';
export {
	INFLIGHT_MARKER_KEY,
	INSTRUMENT_ROUTES,
	TURNSTILE_ROUTES,
	hasInflightMarker,
	isInstrumentRoute,
	isTurnstileRoute,
	loadAppRuntime,
	runtimeTrigger,
	whenIdle,
	type AppRuntime,
	type RuntimeTrigger
} from './runtime.ts';
export { LazyModule } from './lazy.svelte.ts';
