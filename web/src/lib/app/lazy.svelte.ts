// Lazy chrome islands (FUX.2, spec §5.3 L2): a component chunk imported on first need and held
// reactively, so the layout renders `{#if island.current}<island.current … />{/if}`.

/**
 * One dynamically imported module default (a Svelte component), loaded at most once. A failed
 * import is reported to the caller and retried on the next request (offline without cache, or a
 * deploy that replaced the chunk).
 */
export class LazyModule<T> {
	/** The loaded default export; null until the chunk arrived. */
	current = $state.raw<T | null>(null);
	#importer: () => Promise<{ default: T }>;
	#pending: Promise<T> | undefined;

	constructor(importer: () => Promise<{ default: T }>) {
		this.#importer = importer;
	}

	/** Resolves with the module default; rejects when the chunk could not be imported. */
	load(): Promise<T> {
		const loaded = this.current;
		if (loaded !== null) return Promise.resolve(loaded);
		return (this.#pending ??= this.#importer().then(
			(module) => {
				this.current = module.default;
				return module.default;
			},
			(error: unknown) => {
				this.#pending = undefined;
				throw error;
			}
		));
	}

	/**
	 * Fire-and-forget warm-up or load (hover, focus, idle, or the state that needs the island).
	 * Failures go to `onerror`, or to the console when the caller has nothing to undo.
	 */
	request(onerror?: (error: unknown) => void): void {
		this.load().catch((error: unknown) => {
			if (onerror) onerror(error);
			else console.warn('Could not load a page component', error);
		});
	}
}
