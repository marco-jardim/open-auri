/**
 * Transport helpers shared by the preview engine and the Transport component (SEEK.1): seek
 * clamping, the random start of blind tests and comparisons, the seek bar's keyboard steps and
 * the clock format. Pure and SSR-safe (no `window`, no engine import), so pages and the navbar
 * can use them without pulling the engine module.
 */

/** Random starts land uniformly in [25 %, 75 %] of the loaded file's length. */
export const RANDOM_START_MIN = 0.25;
export const RANDOM_START_MAX = 0.75;
/**
 * Seeks stay inside [0, duration): never closer to the end than this (or half the file, for
 * very short files), so the looping element never lands on its own end.
 */
export const SEEK_END_GUARD_S = 0.05;
/** Seek bar keyboard: arrows move ±5 s… */
export const SEEK_STEP_S = 5;
/** …and PageUp / PageDown ±10 % of the length. */
export const SEEK_PAGE_FRACTION = 0.1;

/**
 * Where a preview starts: the beginning, a random point in [25 %, 75 %] of the file (blind tests
 * and comparisons), or a position in seconds (clamped to [0, duration)).
 */
export type StartAt = 'beginning' | 'random' | number;

/** A usable length: finite and positive seconds, else null (pink noise, metadata not read). */
export function knownDuration(seconds: number | null | undefined): number | null {
	return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** Clamps `seconds` into [0, duration). NaN becomes 0; ±Infinity the nearest bound. */
export function clampSeek(seconds: number, duration: number): number {
	if (Number.isNaN(seconds) || !(duration > 0)) return 0;
	const end = Math.max(0, duration - Math.min(SEEK_END_GUARD_S, duration / 2));
	return Math.min(Math.max(seconds, 0), end) + 0;
}

/**
 * Uniform random start in [25 %, 75 %] of `duration`.
 * @param random Uniform generator in [0, 1); injectable for deterministic tests.
 */
export function randomStart(duration: number, random: () => number = Math.random): number {
	const draw = random();
	const u = Number.isFinite(draw) ? Math.min(Math.max(draw, 0), 1) : 0.5;
	return duration * (RANDOM_START_MIN + (RANDOM_START_MAX - RANDOM_START_MIN) * u);
}

/** The position (seconds) a start request resolves to, for a known `duration`. */
export function resolveStart(
	startAt: StartAt,
	duration: number,
	random: () => number = Math.random
): number {
	if (startAt === 'beginning') return 0;
	if (startAt === 'random') return clampSeek(randomStart(duration, random), duration);
	return clampSeek(startAt, duration);
}

/**
 * Seek bar keyboard (WAI-ARIA slider): ArrowRight/ArrowUp +5 s, ArrowLeft/ArrowDown −5 s,
 * PageUp/PageDown ±10 % of the length, Home the beginning, End the end. Returns the clamped
 * target, or null for any other key (which the bar then leaves alone).
 */
export function seekKeyTarget(key: string, position: number, duration: number): number | null {
	let target: number;
	switch (key) {
		case 'ArrowRight':
		case 'ArrowUp':
			target = position + SEEK_STEP_S;
			break;
		case 'ArrowLeft':
		case 'ArrowDown':
			target = position - SEEK_STEP_S;
			break;
		case 'PageUp':
			target = position + duration * SEEK_PAGE_FRACTION;
			break;
		case 'PageDown':
			target = position - duration * SEEK_PAGE_FRACTION;
			break;
		case 'Home':
			target = 0;
			break;
		case 'End':
			target = duration;
			break;
		default:
			return null;
	}
	return clampSeek(target, duration);
}

/** `m:ss`, or `h:mm:ss` from one hour. Unknown or negative values read `0:00`. */
export function formatClock(seconds: number): string {
	const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const secs = String(total % 60).padStart(2, '0');
	return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
}
