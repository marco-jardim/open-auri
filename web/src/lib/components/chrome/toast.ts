import { writable } from 'svelte/store';

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastMessage {
	id: number;
	message: string;
	tone: ToastTone;
	/** Milliseconds of unpaused visibility; zero keeps the toast until dismissed. */
	duration: number;
}

export interface ToastOptions {
	tone?: ToastTone;
	duration?: number;
}

/** Create per-app/per-request state when a shared client singleton is not appropriate. */
export function createToastStore() {
	const { subscribe, update, set } = writable<readonly ToastMessage[]>([]);
	let nextId = 0;

	return {
		subscribe,
		push(message: string, { tone = 'info', duration = 5000 }: ToastOptions = {}) {
			if (!message.trim()) throw new TypeError('A toast needs a message.');
			if (!Number.isFinite(duration) || duration < 0) {
				throw new RangeError('Toast duration must be finite and nonnegative.');
			}
			const id = ++nextId;
			update((messages) => [...messages, { id, message, tone, duration }]);
			return id;
		},
		dismiss(id: number) {
			update((messages) => messages.filter((message) => message.id !== id));
		},
		clear() {
			set([]);
		}
	};
}

export type ToastStore = ReturnType<typeof createToastStore>;

/** Client notification queue. Do not push user-specific notifications here during SSR. */
export const toast = createToastStore();
