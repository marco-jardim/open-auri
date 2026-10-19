#!/usr/bin/env node
import { Resvg } from '@cf-wasm/resvg/node';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SOURCE_SVG = fileURLToPath(new URL('../web/static/icons/icon.svg', import.meta.url));
export const ANDROID_RES = fileURLToPath(
  new URL('../apps/android/android/app/src/main/res/', import.meta.url),
);

// This is the icon's own background, also web/src/lib/styles/tokens.css --ink-2: #171715.
const BACKGROUND = '#171715';
const BACKGROUND_PATH = '<path fill="#171715" d="M0 0h512v512H0z"/>';
const DENSITIES = [
  { name: 'mdpi', legacy: 48, foreground: 108 },
  { name: 'hdpi', legacy: 72, foreground: 162 },
  { name: 'xhdpi', legacy: 96, foreground: 216 },
  { name: 'xxhdpi', legacy: 144, foreground: 324 },
  { name: 'xxxhdpi', legacy: 192, foreground: 432 },
];

/**
 * Render an SVG to PNG at the requested pixel width, preserving its aspect ratio.
 * Reusable for the Play Store's 512 x 512 icon. No timestamps or system fonts are used.
 * @param {string} svgText
 * @param {number} size positive integer pixel width
 * @param {Omit<import('@cf-wasm/resvg/node').ResvgRenderOptions, 'fitTo'>} [options]
 * @returns {Promise<Buffer>}
 */
export async function renderPng(svgText, size, options = {}) {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error('PNG size must be a positive integer');
  }
  const renderer = await Resvg.async(svgText, {
    font: { loadSystemFonts: false },
    ...options,
    fitTo: { mode: 'width', value: size },
  });
  try {
    const image = renderer.render();
    try {
      return Buffer.from(image.asPng());
    } finally {
      image.free();
    }
  } finally {
    renderer.free();
  }
}

/**
 * Derive Android variants from the site's known 512 x 512 SVG, without duplicating artwork.
 * Remove only the exact full-bleed background path, not paths with similar colors.
 * Fail closed if the source structure changes so an opaque adaptive layer cannot slip in.
 * @param {string} svgText
 */
export function androidSvgVariants(svgText) {
  const root = /^\s*<svg\b[^>]*\bviewBox="0 0 512 512"[^>]*>([\s\S]*)<\/svg>\s*$/.exec(svgText);
  if (!root) throw new Error('Android icons require the site SVG with viewBox="0 0 512 512"');
  const body = root[1];
  if (body.split(BACKGROUND_PATH).length !== 2) {
    throw new Error(`Expected exactly one full-bleed background path: ${BACKGROUND_PATH}`);
  }
  const artwork = body.replace(BACKGROUND_PATH, '');
  const round = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
<defs><clipPath id="launcher-circle"><circle cx="256" cy="256" r="256"/></clipPath></defs>
<g clip-path="url(#launcher-circle)">${body}</g>
</svg>`;
  // The source's maskable safe circle has diameter 80% of its 512-unit canvas.
  // Map that circle to Android's central 66 dp circle: 66 / 0.8 = 82.5 dp.
  // Center the resulting viewport in the 108 dp layer: (108 - 82.5) / 2 = 12.75 dp.
  const foreground = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="108" height="108">
<svg x="12.75" y="12.75" width="82.5" height="82.5" viewBox="0 0 512 512">${artwork}</svg>
</svg>`;
  return { legacy: svgText, round, foreground };
}

/**
 * Return all launcher resources, keyed by their path relative to Android's res directory.
 * This pure rendering step lets tests detect stale PNGs and XMLs without rewriting them.
 * @param {string} svgText
 * @returns {Promise<Map<string, Buffer>>}
 */
export async function renderAndroidIcons(svgText) {
  const variants = androidSvgVariants(svgText);
  /** @type {Map<string, Buffer>} */
  const files = new Map();
  for (const { name, legacy, foreground } of DENSITIES) {
    files.set(`mipmap-${name}/ic_launcher.png`, await renderPng(variants.legacy, legacy));
    files.set(`mipmap-${name}/ic_launcher_round.png`, await renderPng(variants.round, legacy));
    files.set(
      `mipmap-${name}/ic_launcher_foreground.png`,
      await renderPng(variants.foreground, foreground),
    );
  }
  const adaptive = Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <monochrome android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`);
  files.set('mipmap-anydpi-v26/ic_launcher.xml', adaptive);
  files.set('mipmap-anydpi-v26/ic_launcher_round.xml', adaptive);
  files.set(
    'values/ic_launcher_background.xml',
    Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${BACKGROUND}</color>
</resources>
`),
  );
  return files;
}

/**
 * @param {{ sourcePath?: string, resourceDir?: string }} [options]
 * @returns {Promise<number>} number of written resources
 */
export async function writeAndroidIcons({
  sourcePath = SOURCE_SVG,
  resourceDir = ANDROID_RES,
} = {}) {
  let svgText;
  try {
    svgText = await readFile(sourcePath, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read Android icon SVG at ${sourcePath}`, { cause: error });
  }
  // Render everything before writing, so an invalid SVG leaves all resources untouched.
  const files = await renderAndroidIcons(svgText);
  for (const [relativePath, data] of files) {
    const path = join(resourceDir, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }
  return files.size;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const count = await writeAndroidIcons();
    process.stdout.write(`Android icons: wrote ${count} resources from ${SOURCE_SVG}\n`);
  } catch (error) {
    process.stderr.write(
      `android-icons: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
