export const ANDROID_PLAY_URL = 'https://play.google.com/store/apps/details?id=com.openauri.app';

// T4.3 turns this on when the listing is public; docs/operacao/runbooks/android-release.md.
export const ANDROID_PLAY_LIVE: boolean = false;

export const ANDROID_RELEASES_URL = 'https://github.com/marco-jardim/open-auri/releases/latest';
export const ANDROID_REPORT_URL =
	'https://github.com/marco-jardim/open-auri/issues/new?template=android-cable-report.yml';

export interface AndroidBrowserNavigator {
	userAgent: string;
	userAgentData?: { platform: string };
}

export function isAndroidBrowser(nav?: AndroidBrowserNavigator): boolean {
	return nav?.userAgentData?.platform === 'Android' || /Android/i.test(nav?.userAgent ?? '');
}

export function playStoreHref(isAndroid: boolean): string {
	if (!isAndroid) return ANDROID_PLAY_URL;
	const packageId = new URL(ANDROID_PLAY_URL).searchParams.get('id');
	return `intent://details?id=${packageId}#Intent;scheme=market;package=com.android.vending;S.browser_fallback_url=${encodeURIComponent(ANDROID_PLAY_URL)};end`;
}
