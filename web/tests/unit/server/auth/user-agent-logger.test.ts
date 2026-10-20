import { describe, expect, it } from 'vitest';
import { createAuthLogger, redactLogMessage, type AuthLogEntry } from '#lib/server/auth/logger.ts';
import { reduceUserAgent } from '#lib/server/auth/user-agent.ts';

describe('reduceUserAgent', () => {
	const webView =
		'Mozilla/5.0 (Linux; Android 15; Pixel 9; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36';

	it('prioritizes the Android app and keeps only its public release version', () => {
		expect(reduceUserAgent(`${webView} OpenAuriAndroid/1.2.3`)).toBe(
			'App Android 1.2.3 on Android'
		);
		expect(reduceUserAgent(`${webView} OpenAuriAndroid/12.34.56`)).toBe(
			'App Android 12.34.56 on Android'
		);
		expect(reduceUserAgent(webView)).toBe('Chrome on Android');
		expect(reduceUserAgent(`${webView} NotOpenAuriAndroid/1.2.3`)).toBe('Chrome on Android');
	});

	it.each(['', '/', '/1.2', '/1.2.3.4', '/1.2.3-beta', '/unknown'])(
		'labels the app without an invalid or missing version: %s',
		(suffix) => {
			expect(reduceUserAgent(`${webView} OpenAuriAndroid${suffix}`)).toBe('App Android on Android');
		}
	);

	it('keeps only browser family and operating system', () => {
		expect(
			reduceUserAgent(
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
			)
		).toBe('Chrome on Windows');
		expect(
			reduceUserAgent(
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0'
			)
		).toBe('Edge on Windows');
		expect(
			reduceUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0')
		).toBe('Firefox on Linux');
		expect(
			reduceUserAgent(
				'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
			)
		).toBe('Safari on iOS');
		expect(
			reduceUserAgent(
				'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'
			)
		).toBe('Chrome on Android');
		expect(reduceUserAgent('curl/8.9.1')).toBe('Other on Other');
		expect(reduceUserAgent('')).toBe('');
		expect(reduceUserAgent(null)).toBe('');
	});
});

describe('auth logger', () => {
	it('redacts e-mails, URLs, IPs and tokens', () => {
		const message = redactLogMessage(
			'Sign-up attempt for existing email: ana.silva+x@example.com from 203.0.113.9 / 2001:db8::1 at https://evil.example/cb token eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImEifQ.sig_abcdefghijklmnopqrstu'
		);
		expect(message).not.toMatch(/example\.com|203\.0\.113\.9|2001:db8|evil\.example|eyJ/);
		expect(message).toContain('[email]');
		expect(message).toContain('[ip]');
		expect(message).toContain('[url]');
		expect(message).toContain('[redacted]');
	});

	it('logs at warn level and keeps only error names from extra arguments', () => {
		const entries: AuthLogEntry[] = [];
		const logger = createAuthLogger((entry) => entries.push(entry));
		expect(logger.level).toBe('warn');
		logger.log('error', 'Failed for a@b.example', new TypeError('secret detail a@b.example'), {
			email: 'a@b.example'
		});
		expect(entries).toEqual([
			{
				event: 'better_auth.log',
				level: 'error',
				message: 'Failed for [email]',
				errors: ['TypeError']
			}
		]);
		expect(JSON.stringify(entries)).not.toContain('a@b.example');
	});
});
