// Client-only form enhancement types (DOM); kept apart from types.ts, which server modules import.
export interface EnhanceHooks {
	/** Called when the enhanced submission starts. */
	onSubmit: () => void;
	/** Called after Kit applied the result (redirect, failure or success). */
	onDone: () => void;
}

export type FormEnhancer = (
	form: HTMLFormElement,
	hooks: EnhanceHooks
) => { destroy(): void } | void;
