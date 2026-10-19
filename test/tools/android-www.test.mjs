import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'))?.[2];
}

for (const name of ['index.html', 'offline.html']) {
  test(`Android bundled ${name} is self-contained and all inline scripts have CSP hashes`, () => {
    // HTML parsing normalizes line endings before CSP hashes are checked by the browser.
    const html = readFileSync(
      new URL(`../../apps/android/www/${name}`, import.meta.url),
      'utf8',
    ).replace(/\r\n?/g, '\n');
    assert.doesNotMatch(html, /<script\b[^>]*\bsrc\s*=/i);
    assert.doesNotMatch(
      html,
      /\b[a-z][a-z0-9+.-]*:\/\//i,
      'no external URLs, including the product origin',
    );
    assert.doesNotMatch(html, /(?:^|[\s"'=(])\/\/[a-z0-9]/i, 'no protocol-relative URLs');
    assert.doesNotMatch(html, /\u2014/u);
    const meta = [...html.matchAll(/<meta\b[^>]*>/gi)].find(
      ([tag]) => attribute(tag, 'http-equiv')?.toLowerCase() === 'content-security-policy',
    );
    assert.ok(meta, 'a CSP meta tag is required');
    const csp = attribute(meta[0], 'content');
    assert.ok(csp, 'CSP content is required');
    for (const [, , body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      const hash = createHash('sha256').update(body).digest('base64');
      const source = `'sha256-${hash}'`;
      assert.ok(csp.includes(source), `CSP must contain ${source}`);
      const scriptPolicy = csp.split(';').find((directive) => /^\s*script-src\s/.test(directive));
      assert.ok(scriptPolicy?.includes(source), 'the hash must authorize script-src');
    }
    if (name === 'offline.html') {
      assert.match(html, /lang="pt-BR"/);
      assert.match(html, /en-US/);
      assert.match(html, /Tentar de novo/);
      assert.match(html, /Try again/);
    }
  });
}
