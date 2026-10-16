// Busy state, Turnstile refresh and focus handling shared by the enhanced auth forms.
import { tick } from 'svelte';
import type { FormEnhancer } from './enhancer-types.ts';

export class FormController {
	/** True while an enhanced submission is in flight. */
	busy = $state(false);
	/** Bumped after every enhanced submission (Turnstile tokens are single use). */
	attempt = $state(0);
	readonly #enhancer: () => FormEnhancer | undefined;

	/** `enhancer` is a getter so the component's prop is read when the form mounts. */
	constructor(enhancer: () => FormEnhancer | undefined) {
		this.#enhancer = enhancer;
	}

	/** Svelte action: `<form use:controller.enhance>`. A plain HTML form when no enhancer. */
	enhance = (form: HTMLFormElement): { destroy(): void } | undefined => {
		const handle = this.#enhancer()?.(form, {
			onSubmit: () => {
				this.busy = true;
			},
			onDone: () => {
				this.busy = false;
				this.attempt += 1;
				void tick().then(() => focusFirstInvalid(form));
			}
		});
		return handle ?? undefined;
	};
}

/** Moves focus to the first invalid field so keyboard and screen-reader users land on it. */
export function focusFirstInvalid(form: HTMLFormElement): boolean {
	const invalid = form.querySelector<HTMLElement>('[aria-invalid="true"]');
	if (!invalid) return false;
	invalid.focus();
	return true;
}
