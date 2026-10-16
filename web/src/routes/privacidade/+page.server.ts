import * as publicConfig from '#lib/config/public.ts';
import { renderLegalPage } from '#lib/content/legal/render.ts';

// Runs at prerender only (see +page.ts): a missing required operator field fails the build.
export function load() {
	return renderLegalPage('privacy', publicConfig);
}
