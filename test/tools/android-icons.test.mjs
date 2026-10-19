import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
import {
  ANDROID_RES,
  SOURCE_SVG,
  TEMPLATE_SPLASH_DIRS,
  androidSvgVariants,
  renderAndroidIcons,
  renderPng,
  writeAndroidIcons,
} from '../../tools/android-icons.mjs';

const svgText = await readFile(SOURCE_SVG, 'utf8');
const fresh = await renderAndroidIcons(svgText);
// Keep these expected dimensions independent from the generator's density table.
const densities = [
  ['mdpi', 48, 108],
  ['hdpi', 72, 162],
  ['xhdpi', 96, 216],
  ['xxhdpi', 144, 324],
  ['xxxhdpi', 192, 432],
];

function dimensions(png) {
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(png.readUInt32BE(8), 13);
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

// Decode the renderer's 8-bit RGBA PNGs using only node:zlib, including all PNG row filters.
function rgba(png) {
  const [width, height] = dimensions(png);
  assert.equal(png[24], 8, '8-bit channels');
  assert.equal(png[25], 6, 'RGBA color type');
  assert.equal(png[28], 0, 'not interlaced');
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
      chunks.push(png.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  const packed = inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  assert.equal(packed.length, height * (stride + 1));
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = packed[y * (stride + 1)];
    assert.ok(filter <= 4, `valid PNG filter ${filter}`);
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x;
      const left = x >= 4 ? pixels[index - 4] : 0;
      const up = y > 0 ? pixels[index - stride] : 0;
      const upperLeft = y > 0 && x >= 4 ? pixels[index - stride - 4] : 0;
      const p = left + up - upperLeft;
      const a = Math.abs(p - left);
      const b = Math.abs(p - up);
      const c = Math.abs(p - upperLeft);
      const paeth = a <= b && a <= c ? left : b <= c ? up : upperLeft;
      const prediction = [0, left, up, Math.floor((left + up) / 2), paeth][filter];
      pixels[index] = (packed[y * (stride + 1) + 1 + x] + prediction) & 255;
    }
  }
  return { width, height, pixels };
}

function alphaAt(image, x, y) {
  return image.pixels[(y * image.width + x) * 4 + 3];
}

function transparentCorners(image) {
  for (const [x, y] of [
    [0, 0],
    [image.width - 1, 0],
    [0, image.height - 1],
    [image.width - 1, image.height - 1],
  ]) {
    assert.equal(alphaAt(image, x, y), 0, `transparent corner ${x},${y}`);
  }
}

test('all 15 fresh and committed Android PNGs have the specified IHDR dimensions', async () => {
  assert.equal(fresh.size, 19, '15 PNGs plus four XML resources');
  for (const [density, legacy, foreground] of densities) {
    for (const [name, size] of [
      ['ic_launcher', legacy],
      ['ic_launcher_round', legacy],
      ['ic_launcher_foreground', foreground],
    ]) {
      const path = `mipmap-${density}/${name}.png`;
      assert.deepEqual(dimensions(fresh.get(path)), [size, size], path);
      assert.deepEqual(dimensions(await readFile(join(ANDROID_RES, path))), [size, size], path);
    }
  }
});

test('every committed launcher resource equals a fresh render of the site SVG', async () => {
  for (const [path, expected] of fresh) {
    const committed = await readFile(join(ANDROID_RES, path));
    assert.ok(committed.equals(expected), `${path} drifted; run node tools/android-icons.mjs`);
  }
});

test('two independent renders have identical bytes and SHA-256 hashes', async () => {
  const repeated = await renderAndroidIcons(svgText);
  for (const [path, expected] of fresh) {
    const actual = repeated.get(path);
    assert.deepEqual(actual, expected, path);
    assert.equal(
      createHash('sha256').update(actual).digest('hex'),
      createHash('sha256').update(expected).digest('hex'),
      path,
    );
  }
});

test('legacy icons have rounded corners and an 8% margin; round icons have circular clipping', () => {
  for (const [density] of densities) {
    const legacy = rgba(fresh.get(`mipmap-${density}/ic_launcher.png`));
    transparentCorners(legacy);
    assert.equal(alphaAt(legacy, legacy.width / 2, legacy.height / 2), 255);
    const backgroundIndex =
      (Math.floor(legacy.height * 0.15) * legacy.width + legacy.width / 2) * 4;
    assert.deepEqual([...legacy.pixels.subarray(backgroundIndex, backgroundIndex + 4)], [
      0x17, 0x17, 0x15, 255,
    ]);
    for (let y = 0; y < legacy.height; y++) {
      for (let x = 0; x < legacy.width; x++) {
        if (
          x + 1 <= legacy.width * 0.08 || x >= legacy.width * 0.92 ||
          y + 1 <= legacy.height * 0.08 || y >= legacy.height * 0.92
        ) {
          assert.equal(alphaAt(legacy, x, y), 0, `${density}: transparent legacy margin`);
        }
      }
    }
    const round = rgba(fresh.get(`mipmap-${density}/ic_launcher_round.png`));
    transparentCorners(round);
    assert.equal(alphaAt(round, round.width / 2, round.height / 2), 255);
    for (let y = 0; y < round.height; y++) {
      for (let x = 0; x < round.width; x++) {
        if (
          Math.hypot(x + 0.5 - round.width / 2, y + 0.5 - round.height / 2) >
          round.width / 2 + 1
        ) {
          assert.equal(alphaAt(round, x, y), 0, `${density}: outside round mask`);
        }
      }
    }
  }
});

test('adaptive foregrounds have transparent corners and artwork inside the central 66 dp circle', () => {
  for (const [density] of densities) {
    const image = rgba(fresh.get(`mipmap-${density}/ic_launcher_foreground.png`));
    transparentCorners(image);
    let visible = 0;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        if (alphaAt(image, x, y) === 0) continue;
        visible++;
        const radius = Math.hypot(x + 0.5 - image.width / 2, y + 0.5 - image.height / 2);
        assert.ok(radius <= (33 / 108) * image.width + 1, `${density}: outside adaptive safe zone`);
      }
    }
    assert.ok(visible > 0, `${density}: nonempty artwork`);
    assert.ok(visible < (image.width * image.height) / 2, `${density}: no full-bleed background`);
  }
});

test('adaptive XMLs use the icon background, mipmap foreground and monochrome layer', () => {
  const icon = fresh.get('mipmap-anydpi/ic_launcher.xml').toString();
  assert.match(
    icon,
    /<adaptive-icon xmlns:android="http:\/\/schemas.android.com\/apk\/res\/android">/,
  );
  assert.match(icon, /<background android:drawable="@color\/ic_launcher_background"\/>/);
  assert.match(icon, /<foreground android:drawable="@mipmap\/ic_launcher_foreground"\/>/);
  assert.match(icon, /<monochrome android:drawable="@mipmap\/ic_launcher_foreground"\/>/);
  assert.match(icon, /<\/adaptive-icon>\s*$/);
  assert.equal(fresh.get('mipmap-anydpi/ic_launcher_round.xml').toString(), icon);
  assert.match(
    fresh.get('values/ic_launcher_background.xml').toString(),
    /<color name="ic_launcher_background">#171715<\/color>/,
  );
});

test('splash keeps its drawable reference without inconsistent template bitmaps or obsolete qualifiers', async () => {
  assert.match(
    fresh.get('drawable/splash.xml').toString(),
    /<solid android:color="@color\/ic_launcher_background"\/>/,
  );
  const directories = await readdir(ANDROID_RES);
  assert.ok(!directories.includes('drawable-v24'));
  for (const directory of TEMPLATE_SPLASH_DIRS) {
    if (!directories.includes(directory)) continue;
    const files = await readdir(join(ANDROID_RES, directory));
    assert.ok(!files.includes('splash.png'), `${directory}: obsolete template splash`);
  }
});

test('the reusable renderer supports the 512 px Play Store icon and render options', async () => {
  assert.deepEqual(dimensions(await renderPng(svgText, 512)), [512, 512]);
  const empty = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>';
  const image = rgba(await renderPng(empty, 2, { background: '#171715' }));
  assert.deepEqual([...image.pixels.subarray(0, 4)], [0x17, 0x17, 0x15, 255]);
  for (const invalid of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(renderPng(svgText, invalid), /PNG size must be a positive integer/);
  }
});

test('missing SVG reports its source path clearly before writing any resources', async () => {
  const missing = join(SOURCE_SVG, 'missing-icon.svg');
  await assert.rejects(writeAndroidIcons({ sourcePath: missing }), (error) => {
    assert.match(error.message, /Cannot read Android icon SVG at/);
    assert.ok(error.message.includes(missing));
    assert.ok(error.cause instanceof Error);
    return true;
  });
});

test('foreground derivation rejects a missing, changed or repeated background path', () => {
  const background = '<path fill="#171715" d="M0 0h512v512H0z"/>';
  for (const invalid of [
    svgText.replace(background, ''),
    svgText.replace(background, background.replace('#171715', '#FFFFFF')),
    svgText.replace(background, background + background),
  ]) {
    assert.throws(
      () => androidSvgVariants(invalid),
      /Expected exactly one full-bleed background path/,
    );
  }
  assert.throws(() => androidSvgVariants('<svg/>'), /require the site SVG with viewBox/);
});
