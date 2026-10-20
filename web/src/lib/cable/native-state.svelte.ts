// Compatibility exports; the holder and gate live in an existing initial-chunk module.
export {
	NATIVE_CABLE_CONTEXT,
	createNativeCableState,
	setNativeCableState,
	getNativeCableState,
	mountNativeCable,
	type NativeCableStatus,
	type NativeCableState
} from '#lib/app/context.svelte.ts';
