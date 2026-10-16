// SVG → PNG with @cf-wasm/resvg (PF4 decision). The module is imported dynamically INSIDE
// renderPng: a static top-level import breaks the SvelteKit build analysis (it loads the module in
// Node and the .wasm asks for the `wbg` package). Wrangler bundles the .wasm on deploy and in
// `wrangler dev`. workerd has no system fonts: the TTF files of web/static/og-font/ are read through
// the ASSETS binding (outside the bundle) and kept per isolate.
import type { Env } from '#lib/server/types.ts';
import { OG_MONO } from './svg.ts';

/** Files in web/static/og-font/ (OFL-1.1, see LICENSE-OFL.txt there). */
export const OG_FONT_FILES = ['InstrumentSerif-Regular.ttf', 'JetBrainsMono.ttf'] as const;

export type OgAssets = Pick<Env['ASSETS'], 'fetch'>;

let fontsMemo: Promise<Uint8Array[]> | null = null;

async function fetchFont(assets: OgAssets, origin: string, file: string): Promise<Uint8Array> {
	const response = await assets.fetch(new URL(`/og-font/${file}`, origin));
	if (!response.ok) throw new Error(`og: font ${file} answered ${response.status}`);
	return new Uint8Array(await response.arrayBuffer());
}

/** The OG fonts, fetched once per isolate (a failed load is retried on the next call). */
export function loadOgFonts(assets: OgAssets, origin: string): Promise<Uint8Array[]> {
	if (fontsMemo === null) {
		const pending = Promise.all(OG_FONT_FILES.map((file) => fetchFont(assets, origin, file)));
		fontsMemo = pending;
		pending.catch(() => {
			// Forget the failure so the next request tries again (the caller sees the error).
			if (fontsMemo === pending) fontsMemo = null;
		});
	}
	return fontsMemo;
}

/** Test hook: drops the per-isolate font cache. */
export function resetOgFonts(): void {
	fontsMemo = null;
}

/** Copies bytes into a fresh ArrayBuffer (exact length, never shared). */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

/** Renders `svg` at its own size (1200×630 for the OG card). Same SVG and fonts → same bytes. */
export async function renderPng(svg: string, fonts: readonly Uint8Array[]): Promise<Uint8Array> {
	const { Resvg } = await import('@cf-wasm/resvg/workerd');
	const resvg = await Resvg.async(svg, {
		font: { fontBuffers: [...fonts], defaultFontFamily: OG_MONO }
	});
	let image: ReturnType<typeof resvg.render> | null = null;
	try {
		image = resvg.render();
		return image.asPng();
	} finally {
		image?.free();
		resvg.free();
	}
}
