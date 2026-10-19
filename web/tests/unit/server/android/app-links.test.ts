import { describe, expect, it } from 'vitest';
import {
	buildAndroidAppLinks,
	parseAndroidAppId,
	parseAndroidCertSha256
} from '#lib/server/android/app-links.ts';

const FIRST = Array<string>(32).fill('AB').join(':');
const SECOND = Array<string>(32).fill('01').join(':');

describe('Android App Links configuration', () => {
	it.each(['com.openauri.app', 'com.example.app_2', 'org.Example.app2'])(
		'accepts a Java package name: %s',
		(value) => expect(parseAndroidAppId(value)).toBe(value)
	);

	it.each([
		undefined,
		null,
		'',
		'app',
		'com..app',
		'.com.app',
		'com.2app',
		'com.app-',
		' com.app',
		'com.app/evil'
	])('rejects an invalid package: %j', (value) => expect(parseAndroidAppId(value)).toBeNull());

	it('parses uppercase SHA-256 fingerprints, trims comma spacing and removes duplicates', () => {
		expect(parseAndroidCertSha256(`${FIRST}, ${SECOND} , ${FIRST}`)).toEqual([FIRST, SECOND]);
		expect(parseAndroidCertSha256(FIRST)).toEqual([FIRST]);
		expect(parseAndroidCertSha256('')).toEqual([]);
		expect(parseAndroidCertSha256(undefined)).toEqual([]);
	});

	it.each([
		FIRST.toLowerCase(),
		Array<string>(31).fill('AB').join(':'),
		Array<string>(33).fill('AB').join(':'),
		'AB'.repeat(32),
		Array<string>(32).fill('GG').join(':'),
		`${FIRST},`,
		`${FIRST},invalid`,
		FIRST.replace(':', ': '),
		null
	])('rejects the whole malformed fingerprint list: %j', (value) => {
		expect(parseAndroidCertSha256(value)).toBeNull();
	});

	it('builds exactly the Digital Asset Links statement', () => {
		expect(buildAndroidAppLinks('com.openauri.app', [FIRST, SECOND, FIRST])).toEqual([
			{
				relation: ['delegate_permission/common.handle_all_urls'],
				target: {
					namespace: 'android_app',
					package_name: 'com.openauri.app',
					sha256_cert_fingerprints: [FIRST, SECOND]
				}
			}
		]);
	});

	it('does not publish missing or invalid configuration', () => {
		expect(buildAndroidAppLinks(undefined, undefined)).toBeNull();
		expect(buildAndroidAppLinks(null, [FIRST])).toBeNull();
		expect(buildAndroidAppLinks('invalid', [FIRST])).toBeNull();
		expect(buildAndroidAppLinks('com.openauri.app', [])).toBeNull();
		expect(buildAndroidAppLinks('com.openauri.app', null)).toBeNull();
		expect(buildAndroidAppLinks('com.openauri.app', ['invalid'])).toBeNull();
	});
});
