import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  PLAY_ASSETS,
  checkPlayAssets,
  decodePng,
  renderPlayArt,
  rgbPng,
  validateAsset,
  writePlayAssets,
} from '../../tools/play-assets.mjs';
import { renderPng } from '../../tools/android-icons.mjs';

const fresh = await renderPlayArt();
const expectedShots = [
  '1-editor.png',
  '2-cabo.png',
  '3-comparar.png',
  '4-soe-como-x.png',
  '5-comunidade.png',
  '6-teste-cego.png',
  '7-native-connect.png',
];

test('Play icon is 512x512, 32-bit RGBA, within 1024 KB and full bleed', async () => {
  const png = await readFile(join(PLAY_ASSETS, 'icon-512.png'));
  const image = decodePng(png);
  assert.deepEqual([image.width, image.height, image.colorType, image.channels], [512, 512, 6, 4]);
  assert.ok(png.length <= 1024 * 1024);
  for (let index = 3; index < image.pixels.length; index += 4)
    assert.equal(image.pixels[index], 255);
});

test('feature graphic is 1024x500, 24-bit RGB with no alpha', async () => {
  const image = decodePng(await readFile(join(PLAY_ASSETS, 'feature-1024x500.png')));
  assert.deepEqual([image.width, image.height, image.colorType, image.channels], [1024, 500, 2, 3]);
  // The bundled wordmark font must actually render, not silently disappear.
  let wordmarkPixels = 0;
  for (let y = 180; y < 300; y++) {
    for (let x = 424; x < 950; x++) {
      if (image.pixels[(y * image.width + x) * 3] > 100) wordmarkPixels++;
    }
  }
  assert.ok(wordmarkPixels > 3000, 'wordmark is visible');
});

test('icon and feature graphic match fresh renders and two renders are byte-identical', async () => {
  const repeated = await renderPlayArt();
  for (const [name, expected] of fresh) {
    assert.deepEqual(repeated.get(name), expected, `${name}: deterministic render`);
    assert.deepEqual(
      await readFile(join(PLAY_ASSETS, name)),
      expected,
      `${name}: committed render`,
    );
  }
});

test('each locale has 2..8 RGB phone captures within Play dimensions and aspect limits', async () => {
  const locales = ['pt-BR', 'en-US'];
  for (const locale of locales) {
    const directory = join(PLAY_ASSETS, 'screenshots', locale);
    const names = (await readdir(directory)).filter((name) => name.endsWith('.png')).sort();
    assert.ok(names.length >= 2 && names.length <= 8, locale);
    assert.deepEqual(names, expectedShots, `${locale}: all six app routes`);
    for (const name of names) {
      const png = await readFile(join(directory, name));
      const image = decodePng(png);
      assert.equal(image.colorType, 2, `${locale}/${name}: no alpha`);
      assert.equal(image.channels, 3);
      assert.ok(Math.min(image.width, image.height) >= 320);
      assert.ok(Math.max(image.width, image.height) <= 3840);
      assert.ok(Math.max(image.width, image.height) <= 2 * Math.min(image.width, image.height));
      assert.deepEqual([image.width, image.height], [1080, 1920]);
      assert.deepEqual(rgbPng(png), png, `${locale}/${name}: canonical RGB encoding`);
    }
  }
  for (const name of expectedShots) {
    assert.notDeepEqual(
      await readFile(join(PLAY_ASSETS, 'screenshots', 'pt-BR', name)),
      await readFile(join(PLAY_ASSETS, 'screenshots', 'en-US', name)),
      `${name}: localized captures must differ`,
    );
  }
});

test('RGB conversion composites transparent pixels and is idempotent', async () => {
  const source = await renderPng(
    '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1"><path fill="#ff0000" fill-opacity="0.5" d="M1 0h1v1H1z"/></svg>',
    2,
  );
  const png = rgbPng(source);
  const image = decodePng(png);
  assert.deepEqual([image.width, image.height, image.colorType], [2, 1, 2]);
  assert.deepEqual([...image.pixels.subarray(0, 3)], [15, 15, 14]);
  assert.ok(image.pixels[3] >= 134 && image.pixels[3] <= 136);
  assert.deepEqual([...image.pixels.subarray(4)], [7, 7]);
  assert.deepEqual(rgbPng(png), png);
});

test('validator rejects wrong dimensions, alpha in feature/screenshots and oversized icons', async () => {
  assert.throws(() => validateAsset(fresh.get('icon-512.png'), 'phone.png'), /without alpha/);
  assert.throws(
    () => validateAsset(fresh.get('icon-512.png'), 'feature-1024x500.png'),
    /without alpha/,
  );
  assert.throws(
    () => validateAsset(fresh.get('feature-1024x500.png'), 'icon-512.png'),
    /512x512 RGBA/,
  );
  const render = async (width, height) =>
    rgbPng(
      await renderPng(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"/>`,
        width,
      ),
    );
  assert.throws(() => validateAsset(Buffer.alloc(1024 * 1024 + 1), 'icon-512.png'), /PNG/);
  assert.throws(() => decodePng(Buffer.from('not a PNG')), /signature/);
  const small = await render(319, 500);
  assert.throws(() => validateAsset(small, 'phone.png'), /320/);
  const tall = await render(400, 801);
  assert.throws(() => validateAsset(tall, 'phone.png'), /aspect/);
  assert.throws(() => validateAsset(small, 'feature-1024x500.png'), /1024x500/);
  const corrupt = Buffer.from(fresh.get('icon-512.png'));
  corrupt[40] ^= 1;
  assert.throws(() => decodePng(corrupt), /CRC/);
});

test('--check validates committed assets without writing', async () => {
  assert.equal(await checkPlayAssets(), 16);
});

test('missing captures fail clearly instead of creating placeholder screenshots', async () => {
  const directory = await mkdtemp(join(PLAY_ASSETS, '.missing-test-'));
  try {
    await assert.rejects(writePlayAssets(directory), /Missing screenshots for pt-BR/);
    assert.deepEqual(await readdir(directory), []);
    await writeFile(join(directory, 'icon-512.png'), fresh.get('icon-512.png'));
    await assert.rejects(checkPlayAssets(directory), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('store screenshot spec is opt-in, mobile-only and keeps the native safety banner', async () => {
  const spec = await readFile(
    new URL('../../web/tests/e2e/play-screenshots.spec.ts', import.meta.url),
    'utf8',
  );
  assert.match(spec, /test\.skip\(process\.env\.PLAY_SCREENSHOTS !== '1',/);
  assert.match(spec, /project\.name !== 'mobile'/);
  assert.match(spec, /fixtures\/capacitor-bridge/);
  assert.match(spec, /name: 'oa_lang'/);
  assert.match(spec, /getByRole\('complementary'/);
});
