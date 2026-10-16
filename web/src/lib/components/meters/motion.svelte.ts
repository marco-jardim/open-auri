import { untrack } from 'svelte';
import { READOUT_INTERVAL_MS } from './format.ts';

/**
 * A number that follows `push()` at most once per interval (trailing update guaranteed). Driven only
 * by incoming values: with no new value nothing is scheduled and nothing changes.
 */
export class ThrottledNumber {
	value = $state<number | null>(null);
	#interval: number;
	#lastAt = Number.NEGATIVE_INFINITY;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#pending: number | null = null;

	constructor(intervalMs: number = READOUT_INTERVAL_MS) {
		this.#interval = intervalMs;
	}

	push(next: number | null): void {
		untrack(() => {
			this.#pending = next;
			if (this.#timer !== undefined) return;
			const now = performance.now();
			const wait = this.#lastAt + this.#interval - now;
			if (wait <= 0) {
				this.#commit(now);
				return;
			}
			this.#timer = setTimeout(() => {
				this.#timer = undefined;
				this.#commit(performance.now());
			}, wait);
		});
	}

	#commit(now: number): void {
		this.#lastAt = now;
		if (this.value !== this.#pending) this.value = this.#pending;
	}

	destroy(): void {
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
	}
}

/**
 * Peak hold driven by incoming values: the held value rises immediately and falls to the current
 * value only when a value arrives after `holdMs`. Without new values it never changes.
 */
export class PeakHold {
	value = $state<number | null>(null);
	#holdMs: number;
	#heldAt = Number.NEGATIVE_INFINITY;

	constructor(holdMs: number) {
		this.#holdMs = holdMs;
	}

	push(next: number | null, now: number = performance.now()): void {
		untrack(() => {
			if (next === null) {
				this.value = null;
				return;
			}
			const held = this.value;
			if (held === null || next >= held || now - this.#heldAt >= this.#holdMs) {
				this.value = next;
				this.#heldAt = now;
			}
		});
	}
}
