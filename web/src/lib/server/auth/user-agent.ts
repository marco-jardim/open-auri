// Session user agent reduced to browser family and operating system (plan T3.5 item 7): enough
// for the "active sessions" list, without the version and build details that fingerprint a device.
// The Android app keeps only its public release version, never WebView/device build details.

const BROWSERS: readonly (readonly [RegExp, string])[] = [
	[/\bEdg(?:e|A|iOS)?\//, 'Edge'],
	[/\b(?:OPR|Opera)\//, 'Opera'],
	[/\bSamsungBrowser\//, 'Samsung Internet'],
	[/\b(?:Firefox|FxiOS)\//, 'Firefox'],
	[/\b(?:Chrome|CriOS|Chromium)\//, 'Chrome'],
	[/\bVersion\/[\d.]+.*\bSafari\//, 'Safari']
];

const SYSTEMS: readonly (readonly [RegExp, string])[] = [
	[/\b(?:iPhone|iPad|iPod)\b/, 'iOS'],
	[/\bAndroid\b/, 'Android'],
	[/\bCrOS\b/, 'ChromeOS'],
	[/\bWindows\b/, 'Windows'],
	[/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
	[/\bLinux\b/, 'Linux']
];

function pick(table: readonly (readonly [RegExp, string])[], value: string): string {
	for (const [pattern, label] of table) if (pattern.test(value)) return label;
	return 'Other';
}

/** `"Firefox on Linux"`, `"Other on Other"` for unknown agents, `""` when there is none. */
export function reduceUserAgent(userAgent: string | null | undefined): string {
	if (!userAgent) return '';
	const value = userAgent.slice(0, 512);
	const app = /(?:^|\s)OpenAuriAndroid(?:\/([^\s;()]*))?(?=$|[\s;()])/.exec(value);
	if (app) {
		const version = /^\d+\.\d+\.\d+$/.test(app[1] ?? '') ? ` ${app[1]}` : '';
		return `App Android${version} on Android`;
	}
	return `${pick(BROWSERS, value)} on ${pick(SYSTEMS, value)}`;
}
