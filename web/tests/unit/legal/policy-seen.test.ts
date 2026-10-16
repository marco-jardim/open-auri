import { describe, expect, test } from 'vitest';
import {
	browserStorage,
	resolveAnonymousSeen,
	writePolicySeen,
	type SeenStorage,
	type StorageHost
} from '#lib/components/legal/policy-seen.ts';
import { POLICY_SEEN_KEY, POLICY_VERSION } from '#lib/content/legal/version.ts';

function memoryStorage(initial: Record<string, string> = {}) {
	const data = new Map(Object.entries(initial));
	const storage: SeenStorage = {
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => {
			data.set(key, value);
		}
	};
	return { storage, data };
}

const failing: SeenStorage = {
	getItem: () => {
		throw new Error('blocked');
	},
	setItem: () => {
		throw new Error('quota');
	}
};

describe('anonymous policy notice storage', () => {
	test('first visit records the current version silently (no banner)', () => {
		const { storage, data } = memoryStorage();
		expect(resolveAnonymousSeen(POLICY_VERSION, storage)).toBe(POLICY_VERSION);
		expect(data.get(POLICY_SEEN_KEY)).toBe(POLICY_VERSION);
		expect(POLICY_SEEN_KEY).toBe('oa.policy.seen');
	});

	test('a stored older version is returned so the banner shows', () => {
		const { storage, data } = memoryStorage({ [POLICY_SEEN_KEY]: '2020-01-01' });
		expect(resolveAnonymousSeen(POLICY_VERSION, storage)).toBe('2020-01-01');
		expect(data.get(POLICY_SEEN_KEY)).toBe('2020-01-01');
	});

	test('garbage in storage is treated as a first visit', () => {
		const { storage, data } = memoryStorage({ [POLICY_SEEN_KEY]: '<script>' });
		expect(resolveAnonymousSeen(POLICY_VERSION, storage)).toBe(POLICY_VERSION);
		expect(data.get(POLICY_SEEN_KEY)).toBe(POLICY_VERSION);
	});

	test('writePolicySeen stores the version and reports unavailable storage', () => {
		const { storage, data } = memoryStorage();
		expect(writePolicySeen('2026-12-01', storage)).toBe(true);
		expect(data.get(POLICY_SEEN_KEY)).toBe('2026-12-01');
		expect(writePolicySeen('2026-12-01', failing)).toBe(false);
		expect(writePolicySeen('2026-12-01', null)).toBe(false);
	});

	test('without usable storage the banner never shows', () => {
		expect(resolveAnonymousSeen(POLICY_VERSION, failing)).toBe(POLICY_VERSION);
		expect(resolveAnonymousSeen(POLICY_VERSION, null)).toBe(POLICY_VERSION);
	});

	test('browserStorage reads the host localStorage and survives absent or blocked storage', () => {
		const { storage, data } = memoryStorage({ [POLICY_SEEN_KEY]: '2020-01-01' });
		const host: StorageHost = { localStorage: storage };
		expect(browserStorage(host)).toBe(storage);
		expect(resolveAnonymousSeen(POLICY_VERSION, browserStorage(host))).toBe('2020-01-01');
		expect(writePolicySeen(POLICY_VERSION, browserStorage(host))).toBe(true);
		expect(data.get(POLICY_SEEN_KEY)).toBe(POLICY_VERSION);

		expect(browserStorage({})).toBeNull();
		expect(browserStorage({ localStorage: null })).toBeNull();
		const blocked: StorageHost = {
			get localStorage(): SeenStorage {
				throw new Error('SecurityError');
			}
		};
		expect(browserStorage(blocked)).toBeNull();
		expect(resolveAnonymousSeen(POLICY_VERSION, browserStorage(blocked))).toBe(POLICY_VERSION);
		expect(writePolicySeen(POLICY_VERSION, browserStorage(blocked))).toBe(false);
	});
});
