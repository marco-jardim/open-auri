import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  PLAY_ASSETS,
  SCREENSHOT_SETS,
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
const expectedSets = [
  { name: 'phone', width: 1080, height: 1920, minSide: 320, maxSide: 3840, files: expectedShots },
  {
    name: 'tablet-7',
    width: 1080,
    height: 1920,
    minSide: 320,
    maxSide: 3840,
    files: expectedShots,
  },
  {
    name: 'tablet-10',
    width: 1440,
    height: 2560,
    minSide: 1080,
    maxSide: 7680,
    files: expectedShots,
  },
  {
    name: 'desktop',
    width: 1920,
    height: 1080,
    minSide: 1080,
    maxSide: 7680,
    files: expectedShots.slice(0, 6),
  },
];
const setFolder = (locale, set) =>
  join('screenshots', locale, ...(set.name === 'phone' ? [] : [set.name]));

async function blankPng(width, height) {
  return rgbPng(
    await renderPng(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"/>`,
      width,
    ),
  );
}

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

test('each locale has seven phone/tablet and six desktop captures with exact Play specs', async () => {
  assert.deepEqual(
    SCREENSHOT_SETS,
    expectedSets,
    'pinned sizes, side limits, scene names and counts',
  );
  const locales = ['pt-BR', 'en-US'];
  for (const locale of locales) {
    for (const set of expectedSets) {
      const folder = setFolder(locale, set);
      const names = (await readdir(join(PLAY_ASSETS, folder)))
        .filter((name) => /\.(png|jpe?g)$/i.test(name))
        .sort();
      assert.deepEqual(names, set.files, `${locale}/${set.name}: exact scene manifest`);
      assert.ok(names.length >= (set.name === 'desktop' ? 4 : 2) && names.length <= 8);
      for (const name of names) {
        const path = join(folder, name);
        const png = await readFile(join(PLAY_ASSETS, path));
        const image = validateAsset(png, path);
        assert.equal(image.colorType, 2, `${path}: no alpha`);
        assert.equal(image.channels, 3);
        assert.ok(png.length <= 8 * 1024 * 1024, `${path}: at most 8 MB`);
        assert.ok(Math.min(image.width, image.height) >= set.minSide);
        assert.ok(Math.max(image.width, image.height) <= set.maxSide);
        assert.ok(image.width * 16 === image.height * 9 || image.width * 9 === image.height * 16);
        assert.deepEqual([image.width, image.height], [set.width, set.height]);
        assert.deepEqual(rgbPng(png), png, `${path}: canonical RGB encoding`);
      }
    }
  }
  for (const set of expectedSets) {
    for (const name of set.files) {
      assert.notDeepEqual(
        await readFile(join(PLAY_ASSETS, setFolder('pt-BR', set), name)),
        await readFile(join(PLAY_ASSETS, setFolder('en-US', set), name)),
        `${set.name}/${name}: localized captures must differ`,
      );
    }
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
  assert.throws(() => validateAsset(Buffer.alloc(1024 * 1024 + 1), 'icon-512.png'), /PNG/);
  assert.throws(() => decodePng(Buffer.from('not a PNG')), /signature/);
  const small = await blankPng(319, 500);
  assert.throws(() => validateAsset(small, '1-editor.png'), /320/);
  const tall = await blankPng(400, 801);
  assert.throws(() => validateAsset(tall, '1-editor.png'), /aspect/);
  assert.throws(() => validateAsset(small, 'feature-1024x500.png'), /1024x500/);
  const corrupt = Buffer.from(fresh.get('icon-512.png'));
  corrupt[40] ^= 1;
  assert.throws(() => decodePng(corrupt), /CRC/);
});

test('validator enforces per-set bounds, exact aspect/resolution, 8 MB and known paths', async () => {
  const phone = await readFile(join(PLAY_ASSETS, 'screenshots', 'pt-BR', '1-editor.png'));
  validateAsset(phone, '1-editor.png');
  validateAsset(phone, 'screenshots\\en-US\\tablet-7\\1-editor.png');
  for (const set of expectedSets) {
    const path = join(setFolder('pt-BR', set), '1-editor.png');
    assert.throws(() => validateAsset(Buffer.alloc(8 * 1024 * 1024 + 1), path), /at most 8 MB/);
    assert.throws(() => validateAsset(fresh.get('icon-512.png'), path), /without alpha/);
  }
  const lowResolution = await blankPng(720, 1280);
  assert.throws(() => validateAsset(lowResolution, '1-editor.png'), /expected 1080x1920/);
  assert.throws(() => validateAsset(lowResolution, 'tablet-7/1-editor.png'), /expected 1080x1920/);
  assert.throws(() => validateAsset(lowResolution, 'tablet-10/1-editor.png'), /1080\.\.7680/);
  assert.throws(() => validateAsset(lowResolution, 'desktop/1-editor.png'), /1080\.\.7680/);
  assert.throws(() => validateAsset(phone, 'tablet-10/1-editor.png'), /expected 1440x2560/);
  assert.throws(() => validateAsset(phone, 'desktop/1-editor.png'), /expected 1920x1080/);
  const notExact = await blankPng(1080, 1919);
  assert.throws(() => validateAsset(notExact, '1-editor.png'), /exactly 16:9 or 9:16/);
  const tooWide = await blankPng(3841, 320);
  assert.throws(() => validateAsset(tooWide, 'tablet-7/1-editor.png'), /320\.\.3840/);
  const overDecoderLimit = await renderPng(
    '<svg xmlns="http://www.w3.org/2000/svg" width="7681" height="1"/>',
    7681,
  );
  assert.throws(() => decodePng(overDecoderLimit), /dimensions/);
  const landscape = await blankPng(1920, 1080);
  validateAsset(landscape, 'desktop/1-editor.png');
  assert.throws(() => validateAsset(landscape, 'tablet-7/1-editor.png'), /expected 1080x1920/);
  for (const path of [
    'screenshots/fr-FR/1-editor.png',
    'screenshots/pt-BR/unknown/1-editor.png',
    'desktop/7-native-connect.png',
    '8-extra.png',
  ])
    assert.throws(() => validateAsset(phone, path), /unknown screenshot/);
});

test('--check validates committed assets without writing', async () => {
  assert.equal(await checkPlayAssets(), 56);
});

test('missing captures fail clearly instead of creating placeholder screenshots', async () => {
  const directory = await mkdtemp(join(PLAY_ASSETS, 'missing-test-'));
  try {
    await assert.rejects(writePlayAssets(directory), /Missing screenshots for pt-BR/);
    assert.deepEqual(await readdir(directory), []);
    await writeFile(join(directory, 'icon-512.png'), fresh.get('icon-512.png'));
    await assert.rejects(checkPlayAssets(directory), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing sets, missing/extra scenes and wrong names fail before normalizing or writing', async () => {
  const directory = await mkdtemp(join(PLAY_ASSETS, 'manifest-test-'));
  try {
    for (const [name, png] of fresh) await writeFile(join(directory, name), png);
    // Only the manifest is read on failure: no placeholder PNG can pass the decoder.
    for (const locale of ['pt-BR', 'en-US']) {
      for (const set of expectedSets) {
        const folder = join(directory, setFolder(locale, set));
        await mkdir(folder, { recursive: true });
        for (const name of set.files) await writeFile(join(folder, name), 'not a PNG');
      }
    }
    for (const set of expectedSets) {
      const folder = join(directory, setFolder('en-US', set));
      const scene = join(folder, set.files.at(-1));
      await rm(scene);
      const message = new RegExp(`en-US/${set.name}: expected exactly ${set.files.length}`);
      await assert.rejects(writePlayAssets(directory), message);
      await assert.rejects(checkPlayAssets(directory), message);
      await writeFile(scene, 'not a PNG');
      const extra = join(folder, '8-extra.png');
      await writeFile(extra, 'not a PNG');
      await assert.rejects(writePlayAssets(directory), message);
      await rm(extra);
      const wrongName = join(folder, 'wrong-name.jpg');
      await rename(scene, wrongName);
      await assert.rejects(writePlayAssets(directory), message);
      await rename(wrongName, scene);
      if (set.name !== 'phone') {
        const moved = `${folder}-missing`;
        await rename(folder, moved);
        await assert.rejects(
          writePlayAssets(directory),
          new RegExp(`Missing screenshots for en-US/${set.name}`),
        );
        await rename(moved, folder);
      }
    }
    assert.equal(
      await readFile(join(directory, 'screenshots', 'pt-BR', '1-editor.png'), 'utf8'),
      'not a PNG',
    );
    const firstScene = join(directory, 'screenshots', 'pt-BR', '1-editor.png');
    await writeFile(firstScene, Buffer.alloc(8 * 1024 * 1024 + 1));
    await assert.rejects(writePlayAssets(directory), /at most 8 MB/);
    await assert.rejects(checkPlayAssets(directory), /at most 8 MB/);
    for (const [name, png] of fresh) assert.deepEqual(await readFile(join(directory, name)), png);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('store screenshot spec is opt-in, single-project and distinguishes native from WebHID', async () => {
  const spec = await readFile(
    new URL('../../web/tests/e2e/play-screenshots.spec.ts', import.meta.url),
    'utf8',
  );
  assert.match(spec, /test\.skip\(process\.env\.PLAY_SCREENSHOTS !== '1',/);
  assert.match(spec, /project\.name !== 'mobile'/);
  assert.match(spec, /fixtures\/capacitor-bridge/);
  assert.match(spec, /name: 'oa_lang'/);
  assert.match(spec, /getByRole\('complementary'/);
  for (const set of expectedSets) assert.match(spec, new RegExp(`name: '${set.name}'`));
  assert.match(spec, /enabled: set\.name !== 'desktop'/);
  assert.match(spec, /isMobile: false,\s+hasTouch: false/);
  assert.match(spec, /OA-01 · WebHID/);
  assert.match(spec, /if \(set\.name === 'desktop'\) return;/);
  assert.match(spec, /frameInstrument\(page, frame\)/);
  for (const name of ['play-listing.md', 'play-console-passos.md']) {
    const doc = await readFile(new URL(`../../docs/android/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(doc, /\u2014/u);
    assert.match(doc, /56 PNGs/);
    for (const set of expectedSets.filter((entry) => entry.name !== 'phone'))
      assert.ok(doc.includes(set.name));
  }
});
