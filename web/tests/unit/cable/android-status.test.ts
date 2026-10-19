import { describe, expect, test, vi } from 'vitest';
import {
	ANDROID_DISCLAIMER_VERSION,
	ANDROID_WRITE_POLICY,
	ANDROID_WRITE_VALIDATED,
	canWriteFromApp,
	compareSemVer,
	isAppVersionBlocked,
	parseSemVer
} from '#lib/cable/android-status.ts';

function semver(value: string) {
	const parsed = parseSemVer(value);
	if (parsed === null) throw new Error(`invalid test version ${value}`);
	return parsed;
}

describe('launch state', () => {
	test('writing is not validated on a cable, the disclaimer is v1 and the policy allows every version', () => {
		expect(ANDROID_WRITE_VALIDATED).toBe(false);
		expect(ANDROID_DISCLAIMER_VERSION).toBe(1);
		expect(ANDROID_WRITE_POLICY).toEqual({ enabled: true, blockedAppVersions: [] });
	});

	test('every shipped blocklist entry parses as an exact version or strict upper bound', () => {
		expect(
			ANDROID_WRITE_POLICY.blockedAppVersions.filter(
				(entry) => parseSemVer(entry.startsWith('<') ? entry.slice(1) : entry) === null
			)
		).toEqual([]);
	});
});

describe('parseSemVer', () => {
	test('accepts SemVer 2.0.0 with pre-release and build metadata', () => {
		expect(parseSemVer('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
		expect(parseSemVer('1.0.0-rc.1+build.7')).toEqual({
			major: 1,
			minor: 0,
			patch: 0,
			prerelease: ['rc', '1']
		});
	});

	test.each([
		'',
		'1',
		'1.0',
		'1.0.0.0',
		'v1.0.0',
		'01.0.0',
		'1.0.0-',
		'1.0.0-01',
		' 1.0.0',
		'1.0.0 '
	])('rejects %j', (value) => {
		expect(parseSemVer(value)).toBeNull();
	});
});

describe('compareSemVer', () => {
	test('orders by major, minor and patch', () => {
		expect(compareSemVer(semver('1.0.0'), semver('2.0.0'))).toBeLessThan(0);
		expect(compareSemVer(semver('1.2.0'), semver('1.1.9'))).toBeGreaterThan(0);
		expect(compareSemVer(semver('1.0.10'), semver('1.0.9'))).toBeGreaterThan(0);
		expect(compareSemVer(semver('1.0.0+a'), semver('1.0.0+b'))).toBe(0);
	});

	test('follows SemVer pre-release precedence', () => {
		const ordered = [
			'1.0.0-alpha',
			'1.0.0-alpha.1',
			'1.0.0-alpha.beta',
			'1.0.0-beta',
			'1.0.0-beta.2',
			'1.0.0-beta.11',
			'1.0.0-rc.1',
			'1.0.0'
		];
		for (let i = 0; i < ordered.length - 1; i++) {
			const lower = ordered[i] ?? '';
			const higher = ordered[i + 1] ?? '';
			expect(compareSemVer(semver(lower), semver(higher)), `${lower} < ${higher}`).toBeLessThan(0);
			expect(compareSemVer(semver(higher), semver(lower))).toBeGreaterThan(0);
		}
		expect(compareSemVer(semver('1.0.0-rc.1'), semver('1.0.0-rc.1'))).toBe(0);
	});
});

describe('isAppVersionBlocked', () => {
	test('an empty list blocks nothing valid', () => {
		expect(isAppVersionBlocked('1.0.0', [])).toBe(false);
	});

	test('exact entries match only that version', () => {
		expect(isAppVersionBlocked('1.0.1', ['1.0.1'])).toBe(true);
		expect(isAppVersionBlocked('1.0.2', ['1.0.1'])).toBe(false);
		expect(isAppVersionBlocked('1.0.1-rc.1', ['1.0.1'])).toBe(false);
	});

	test('"<x.y.z" blocks strictly lower versions, pre-releases included', () => {
		expect(isAppVersionBlocked('1.0.2', ['<1.0.3'])).toBe(true);
		expect(isAppVersionBlocked('1.0.3-rc.1', ['<1.0.3'])).toBe(true);
		expect(isAppVersionBlocked('1.0.3', ['<1.0.3'])).toBe(false);
		expect(isAppVersionBlocked('1.1.0', ['<1.0.3'])).toBe(false);
	});

	test('invalid app versions are always blocked', () => {
		expect(isAppVersionBlocked('', [])).toBe(true);
		expect(isAppVersionBlocked('1.0', [])).toBe(true);
		expect(isAppVersionBlocked('unknown', [])).toBe(true);
	});

	test('any malformed blocklist entry blocks every version and logs only once', () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			for (const entry of ['<=1.0.3', 'v1.0.0', '<x', 'abc', '<', '']) {
				for (const version of ['0.0.1', '1.0.0', '99.0.0']) {
					expect(isAppVersionBlocked(version, ['2.0.0', entry]), `${version}: ${entry}`).toBe(true);
				}
			}
			expect(log).toHaveBeenCalledTimes(1);
		} finally {
			log.mockRestore();
		}
	});

	test('defaults to the deployed policy', () => {
		expect(isAppVersionBlocked('1.0.0')).toBe(false);
	});
});

describe('canWriteFromApp', () => {
	test('the deployed policy lets a valid version write', () => {
		expect(canWriteFromApp('1.0.0')).toBe(true);
		expect(canWriteFromApp('not-a-version')).toBe(false);
	});

	test('enabled=false turns writing off for every version', () => {
		expect(canWriteFromApp('1.0.0', { enabled: false, blockedAppVersions: [] })).toBe(false);
	});

	test('a blocked version cannot write while the policy is on', () => {
		const policy = { enabled: true, blockedAppVersions: ['1.0.0', '<0.9.0'] };
		expect(canWriteFromApp('1.0.0', policy)).toBe(false);
		expect(canWriteFromApp('0.8.5', policy)).toBe(false);
		expect(canWriteFromApp('1.0.1', policy)).toBe(true);
	});

	test('a blocked version stays blocked when the policy is also off', () => {
		expect(canWriteFromApp('1.0.0', { enabled: false, blockedAppVersions: ['1.0.0'] })).toBe(false);
	});
});
