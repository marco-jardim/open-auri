#!/usr/bin/env node
// Render: node tools/play-assets.mjs
// Capture: from web, set CI=1 and PLAY_SCREENSHOTS=1, then run
// npx playwright test tests/e2e/play-screenshots.spec.ts --project=mobile --workers=1
// Validate without writing: node tools/play-assets.mjs --check
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import { renderPng, SOURCE_SVG } from './android-icons.mjs';

export const PLAY_ASSETS = fileURLToPath(new URL('../docs/android/play-assets/', import.meta.url));
export const LOCALES = ['pt-BR', 'en-US'];
const FEATURE_SVG = new URL('../design/play/feature-graphic.svg', import.meta.url);
const FONT = new URL('../web/static/og-font/InstrumentSerif-Regular.ttf', import.meta.url);
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const BACKGROUND = [0x0f, 0x0f, 0x0e];

/** @param {Uint8Array} bytes */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  result.write(type, 4, 4, 'ascii');
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}

/** Decode non-interlaced 8-bit RGB/RGBA PNGs, including all five row filters.
 * @param {Buffer} png
 */
export function decodePng(png) {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('Invalid PNG signature');
  if (png.length < 33 || png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('Missing PNG IHDR');
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const colorType = png[25];
  if (!width || !height || width > 3840 || height > 3840) throw new Error('Invalid PNG dimensions');
  if (png[24] !== 8 || ![2, 6].includes(colorType) || png[26] || png[27] || png[28]) {
    throw new Error('Expected non-interlaced 8-bit RGB or RGBA PNG');
  }
  /** @type {Buffer[]} */
  const compressed = [];
  let ended = false;
  for (let offset = 8; offset < png.length;) {
    if (offset + 12 > png.length) throw new Error('Truncated PNG chunk');
    const length = png.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > png.length) throw new Error('Truncated PNG data');
    const type = png.toString('ascii', offset + 4, offset + 8);
    if (crc32(png.subarray(offset + 4, end - 4)) !== png.readUInt32BE(end - 4)) {
      throw new Error(`Invalid PNG CRC: ${type}`);
    }
    if (type === 'tRNS') throw new Error('PNG transparency must use an explicit alpha channel');
    if (type === 'IDAT') compressed.push(png.subarray(offset + 8, end - 4));
    if (type === 'IEND') {
      if (length || end !== png.length) throw new Error('Invalid PNG IEND');
      ended = true;
    }
    offset = end;
  }
  if (!ended || !compressed.length) throw new Error('Incomplete PNG');
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const expected = height * (stride + 1);
  const packed = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
  if (packed.length !== expected) throw new Error('Invalid PNG scanline length');
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    const filter = packed[row];
    if (filter > 4) throw new Error(`Invalid PNG filter: ${filter}`);
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x;
      const left = x >= channels ? pixels[index - channels] : 0;
      const up = y ? pixels[index - stride] : 0;
      const upperLeft = y && x >= channels ? pixels[index - stride - channels] : 0;
      const p = left + up - upperLeft;
      const a = Math.abs(p - left);
      const b = Math.abs(p - up);
      const c = Math.abs(p - upperLeft);
      const paeth = a <= b && a <= c ? left : b <= c ? up : upperLeft;
      const prediction = [0, left, up, Math.floor((left + up) / 2), paeth][filter];
      pixels[index] = (packed[row + 1 + x] + prediction) & 255;
    }
  }
  return { width, height, colorType, channels, pixels };
}

/** Strip metadata and composite alpha onto the app background; output is always 24-bit RGB.
 * @param {Buffer} png
 */
export function rgbPng(png) {
  const { width, height, channels, pixels } = decodePng(png);
  const stride = width * 3;
  const packed = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    // Sub filter compresses flat UI colors without a platform-specific PNG library.
    packed[row] = 1;
    const previous = [0, 0, 0];
    for (let x = 0; x < width; x++) {
      const source = (y * width + x) * channels;
      const alpha = channels === 4 ? pixels[source + 3] : 255;
      for (let channel = 0; channel < 3; channel++) {
        const value = Math.round(
          (pixels[source + channel] * alpha + BACKGROUND[channel] * (255 - alpha)) / 255,
        );
        packed[row + 1 + x * 3 + channel] = (value - previous[channel]) & 255;
        previous[channel] = value;
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(packed, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Pure render, independent of installed system fonts. */
export async function renderPlayArt() {
  const [icon, feature, font] = await Promise.all([
    readFile(SOURCE_SVG, 'utf8'),
    readFile(FEATURE_SVG, 'utf8'),
    readFile(FONT),
  ]);
  return new Map([
    ['icon-512.png', await renderPng(icon, 512)],
    [
      'feature-1024x500.png',
      rgbPng(
        await renderPng(feature, 1024, {
          font: { loadSystemFonts: false, fontBuffers: [font] },
        }),
      ),
    ],
  ]);
}

/** @param {Buffer} png @param {string} name */
export function validateAsset(png, name) {
  const image = decodePng(png);
  const { width, height, colorType } = image;
  if (name === 'icon-512.png') {
    if (width !== 512 || height !== 512 || colorType !== 6 || png.length > 1024 * 1024) {
      throw new Error(`${name}: expected 512x512 RGBA PNG, at most 1024 KB`);
    }
  } else {
    if (colorType !== 2) throw new Error(`${name}: expected 24-bit RGB PNG without alpha`);
    if (name === 'feature-1024x500.png') {
      if (width !== 1024 || height !== 500) throw new Error(`${name}: expected 1024x500`);
    } else if (
      Math.min(width, height) < 320 ||
      Math.max(width, height) > 2 * Math.min(width, height)
    ) {
      throw new Error(`${name}: screenshot sides must be 320..3840 px, aspect at most 2:1`);
    }
  }
  return image;
}

/** @param {string} directory @param {string} locale */
async function screenshotNames(directory, locale) {
  const folder = join(directory, 'screenshots', locale);
  let names;
  try {
    names = (await readdir(folder)).filter((name) => name.endsWith('.png')).sort();
  } catch (error) {
    throw new Error(`Missing screenshots for ${locale}; run the opt-in Playwright capture`, {
      cause: error,
    });
  }
  if (names.length < 2 || names.length > 8)
    throw new Error(`${locale}: expected 2..8 phone screenshots`);
  return names.map((name) => join('screenshots', locale, name));
}

/** Check specs and stale artwork without changing files.
 * @param {string} [directory]
 */
export async function checkPlayAssets(directory = PLAY_ASSETS) {
  const fresh = await renderPlayArt();
  let count = 0;
  for (const [name, expected] of fresh) {
    const actual = await readFile(join(directory, name));
    validateAsset(actual, name);
    if (!actual.equals(expected))
      throw new Error(`${name}: stale artwork; run node tools/play-assets.mjs`);
    count++;
  }
  for (const locale of LOCALES) {
    for (const name of await screenshotNames(directory, locale)) {
      validateAsset(await readFile(join(directory, name)), name);
      count++;
    }
  }
  return count;
}

/** Render artwork and normalize existing Playwright captures. Missing captures fail explicitly.
 * @param {string} [directory]
 */
export async function writePlayAssets(directory = PLAY_ASSETS) {
  const files = await renderPlayArt();
  for (const locale of LOCALES) {
    for (const name of await screenshotNames(directory, locale)) {
      files.set(name, rgbPng(await readFile(join(directory, name))));
    }
  }
  // Validate everything before writing, so a malformed capture leaves assets untouched.
  for (const [name, data] of files) validateAsset(data, name);
  await mkdir(directory, { recursive: true });
  for (const [name, data] of files) await writeFile(join(directory, name), data);
  return files.size;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
      throw new Error('Usage: node tools/play-assets.mjs [--check]');
    }
    const check = args[0] === '--check';
    const count = await (check ? checkPlayAssets() : writePlayAssets());
    process.stdout.write(`Play assets: ${check ? 'validated' : 'wrote'} ${count} PNGs\n`);
  } catch (error) {
    process.stderr.write(
      `play-assets: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
