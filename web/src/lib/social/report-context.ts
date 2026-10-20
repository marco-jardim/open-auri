import { getContext, setContext } from 'svelte';

export const REPORT_SITE_KEY_CONTEXT = Symbol('report turnstile site key');
/** The layout provides the public Turnstile key, so report actions need no route plumbing. */
export function setReportSiteKey(siteKey: string): string {
	return setContext(REPORT_SITE_KEY_CONTEXT, siteKey);
}
/** Isolated previews/tests have no layout provider: no key renders no widget. */
export function getReportSiteKey(): string {
	return getContext<string | undefined>(REPORT_SITE_KEY_CONTEXT) ?? '';
}
