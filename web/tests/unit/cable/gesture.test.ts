import { describe, expect, test } from 'vitest';
import {
	GESTURE_TTL_MS,
	consumeGestureToken,
	createGestureToken
} from '../../../src/lib/cable/gesture.ts';

const active = { isActive: true };
const at = (ms: number) => () => ms;

describe('createGestureToken', () => {
	test('accepts trusted click and key events', () => {
		for (const type of ['click', 'keydown', 'keyup', 'keypress']) {
			const token = createGestureToken({ isTrusted: true, type }, { userActivation: active });
			expect(token, type).not.toBeNull();
		}
	});

	test('refuses untrusted (synthetic) events', () => {
		const options = { userActivation: active };
		expect(createGestureToken({ isTrusted: false, type: 'click' }, options)).toBeNull();
		expect(createGestureToken(new Event('click'), options)).toBeNull();
	});

	test('refuses other event types and missing events', () => {
		const options = { userActivation: active };
		expect(createGestureToken({ isTrusted: true, type: 'mouseover' }, options)).toBeNull();
		expect(createGestureToken({ isTrusted: true, type: 'focus' }, options)).toBeNull();
		expect(createGestureToken(null)).toBeNull();
		expect(createGestureToken(undefined)).toBeNull();
	});

	test('refuses when navigator.userActivation says the page is not active', () => {
		const options = { userActivation: { isActive: false } };
		expect(createGestureToken({ isTrusted: true, type: 'click' }, options)).toBeNull();
	});

	test('works without the userActivation API (null)', () => {
		const options = { userActivation: null };
		expect(createGestureToken({ isTrusted: true, type: 'click' }, options)).not.toBeNull();
	});
});

describe('consumeGestureToken', () => {
	test('a token is single-use', () => {
		const token = createGestureToken(
			{ isTrusted: true, type: 'click' },
			{ userActivation: active, now: at(1000) }
		);
		expect(consumeGestureToken(token, 1000)).toBe(true);
		expect(consumeGestureToken(token, 1000)).toBe(false);
	});

	test(`a token expires after ${GESTURE_TTL_MS} ms and is spent anyway`, () => {
		const token = createGestureToken(
			{ isTrusted: true, type: 'click' },
			{ userActivation: active, now: at(1000) }
		);
		expect(consumeGestureToken(token, 1000 + GESTURE_TTL_MS + 1)).toBe(false);
		expect(consumeGestureToken(token, 1000)).toBe(false);
		const edge = createGestureToken(
			{ isTrusted: true, type: 'click' },
			{ userActivation: active, now: at(1000) }
		);
		expect(consumeGestureToken(edge, 1000 + GESTURE_TTL_MS)).toBe(true);
	});

	test('a token from the future (clock went back) is refused', () => {
		const token = createGestureToken(
			{ isTrusted: true, type: 'click' },
			{ userActivation: active, now: at(5000) }
		);
		expect(consumeGestureToken(token, 4000)).toBe(false);
	});

	test('forged tokens are refused', () => {
		expect(consumeGestureToken({ kind: 'cable-gesture' }, 0)).toBe(false);
		expect(consumeGestureToken(null, 0)).toBe(false);
		expect(consumeGestureToken(undefined, 0)).toBe(false);
		expect(consumeGestureToken('token', 0)).toBe(false);
	});
});
