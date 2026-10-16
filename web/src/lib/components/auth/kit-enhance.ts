// Progressive enhancement for the auth forms, used by the route pages only (component tests render
// the forms without it, as plain HTML forms). Wraps Kit's `enhance` with start/end hooks so the
// forms can show a busy state and refresh the single-use Turnstile token after each attempt.
import { enhance } from '$app/forms';
import type { FormEnhancer } from './types.ts';

export const kitEnhancer: FormEnhancer = (form, hooks) =>
	enhance(form, () => {
		hooks.onSubmit();
		return async ({ update }) => {
			try {
				// Keep what was typed on failures; Kit resets the form only on a success result.
				await update();
			} finally {
				hooks.onDone();
			}
		};
	});
