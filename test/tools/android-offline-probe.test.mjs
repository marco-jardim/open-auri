import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

/** @param {string} path relative to the repository root */
function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

const CLIENT =
  'apps/android/android/app/src/main/java/com/getcapacitor/OfflineAwareWebViewClient.kt';

/** The href of every `<link rel="manifest">` in the site's HTML shell. */
function manifestHrefs(html) {
  return [...html.matchAll(/<link\b[^>]*>/gi)]
    .map(([tag]) => tag)
    .filter((tag) => /\brel\s*=\s*["']manifest["']/i.test(tag))
    .map((tag) => tag.match(/\bhref\s*=\s*(["'])([^"']*)\1/i)?.[2]);
}

/**
 * The `href$=` suffix in SITE_DOCUMENT_PROBE. The Kotlin source escapes the selector's double
 * quotes inside a string literal: link[rel=\"manifest\"][href$=\"...\"].
 */
function probeSuffix(kotlin) {
  const probe = kotlin.match(/SITE_DOCUMENT_PROBE\s*=([\s\S]*?)\n\s*\n/)?.[1] ?? '';
  return probe.match(/link\[rel=\\"manifest\\"\]\[href\$=\\"([^"\\]+)\\"\]/)?.[1];
}

test('the Android offline probe recognises the site by the manifest link app.html really has', () => {
  const hrefs = manifestHrefs(read('web/src/app.html'));
  assert.equal(
    hrefs.length,
    1,
    `app.html must link exactly one web manifest, found ${JSON.stringify(hrefs)}`,
  );
  const [href] = hrefs;
  assert.ok(href, 'the manifest link has no href');
  const suffix = probeSuffix(read(CLIENT));
  assert.ok(suffix, `${CLIENT}: SITE_DOCUMENT_PROBE must select link[rel="manifest"][href$="..."]`);
  // FX4-B: if the shell stops matching, every cached offline page would be replaced by offline.html.
  assert.ok(
    href.endsWith(suffix),
    `app.html manifest href ${href} does not end with the probe suffix ${suffix}`,
  );
  const file = href.replace('%sveltekit.assets%/', '');
  assert.ok(
    existsSync(new URL(`../../web/static/${file}`, import.meta.url)),
    `web/static has no ${file}: the linked manifest would not be served`,
  );
});

test('the probe parsers reject what the selector would not match', () => {
  assert.deepEqual(manifestHrefs('<link rel="icon" href="/x.webmanifest">'), []);
  assert.deepEqual(manifestHrefs('<link\n\trel="manifest"\n\thref="/a/site.webmanifest"\n/>'), [
    '/a/site.webmanifest',
  ]);
  const kotlin =
    'internal const val SITE_DOCUMENT_PROBE =\n    "(document.querySelector(\'link[rel=\\"manifest\\"][href$=\\"app.webmanifest\\"]\') ? 1 : 0)"\n\n';
  assert.equal(probeSuffix(kotlin), 'app.webmanifest');
  assert.equal(
    probeSuffix('internal const val SITE_DOCUMENT_PROBE = "document.title"\n\n'),
    undefined,
  );
});
