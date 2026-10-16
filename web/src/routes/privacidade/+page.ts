import * as publicConfig from '#lib/config/public.ts';
import { publicLegalValues } from '#lib/content/docs/legal.ts';

export const prerender = true;
export function load() {
	return { legalValues: publicLegalValues(publicConfig) };
}
