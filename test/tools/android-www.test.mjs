import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'))?.[2];
}

// Scan tags with quoted-attribute state, comments and raw-text elements. This is intentionally
// not a regex tag filter: HTML permits whitespace and attributes even on a script end tag.
function bundledTags(html) {
  const lower = html.replace(/[A-Z]/g, (char) => char.toLowerCase());
  const tags = [];
  function tagEnd(start) {
    let quote = '';
    for (let i = start; i < html.length; i++) {
      const char = html[i];
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        return i + 1;
      }
    }
    assert.fail('unterminated HTML tag');
  }
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf('<', cursor);
    if (start === -1) break;
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4);
      assert.notEqual(end, -1, 'unterminated HTML comment');
      cursor = end + 3;
      continue;
    }
    let nameEnd = start + 1;
    while (/[a-z0-9:-]/i.test(html[nameEnd] ?? '')) nameEnd++;
    const name = lower.slice(start + 1, nameEnd);
    if (!name || !/[\t\n\f\r />]/.test(html[nameEnd] ?? '')) {
      cursor = start + 1;
      continue;
    }
    const end = tagEnd(nameEnd);
    const tag = { name, opening: html.slice(start, end), body: '' };
    tags.push(tag);
    cursor = end;
    if (['script', 'style', 'title', 'textarea'].includes(name)) {
      let close = end;
      while (true) {
        close = lower.indexOf(`</${name}`, close);
        assert.notEqual(close, -1, `missing end tag for ${name}`);
        const afterName = close + name.length + 2;
        if (/[\t\n\f\r />]/.test(html[afterName] ?? '')) {
          tag.body = html.slice(end, close);
          cursor = tagEnd(afterName);
          break;
        }
        close = afterName;
      }
    }
  }
  return tags;
}

test('bundled HTML scanner handles script end-tag whitespace, attributes, quotes and comments', () => {
  const html =
    `<!-- <script>ignored</script> --><script data-note=">">one</ScRiPt \n>` +
    `<script>two</script data-note=">">`;
  assert.deepEqual(bundledTags(html).map(({ body }) => body), ['one', 'two']);
  assert.deepEqual(
    bundledTags('<style>"<script>"</style><script>İthree</script>')
      .filter(({ name }) => name === 'script')
      .map(({ body }) => body),
    ['İthree'],
  );
  assert.throws(() => bundledTags('<script>unterminated'), /missing end tag/);
  assert.throws(() => bundledTags('<script title="unterminated>'), /unterminated HTML tag/);
  assert.throws(() => bundledTags('<!-- unterminated'), /unterminated HTML comment/);
});

for (const name of ['index.html', 'offline.html']) {
  test(`Android bundled ${name} is self-contained and all inline scripts have CSP hashes`, () => {
    // HTML parsing normalizes line endings before CSP hashes are checked by the browser.
    const html = readFileSync(
      new URL(`../../apps/android/www/${name}`, import.meta.url),
      'utf8',
    ).replace(/\r\n?/g, '\n');
    const tags = bundledTags(html);
    const scripts = tags.filter((tag) => tag.name === 'script');
    assert.equal(scripts.length, name === 'offline.html' ? 1 : 0, 'exact expected script count');
    assert.doesNotMatch(
      html,
      /\b[a-z][a-z0-9+.-]*:\/\//i,
      'no external URLs, including the product origin',
    );
    assert.doesNotMatch(html, /(?:^|[\s"'=(])\/\/[a-z0-9]/i, 'no protocol-relative URLs');
    assert.doesNotMatch(html, /\u2014/u);
    const meta = tags.find(
      (tag) =>
        tag.name === 'meta' &&
        attribute(tag.opening, 'http-equiv')?.toLowerCase() === 'content-security-policy',
    );
    assert.ok(meta, 'a CSP meta tag is required');
    const csp = attribute(meta.opening, 'content');
    assert.ok(csp, 'CSP content is required');
    for (const { opening, body } of scripts) {
      assert.doesNotMatch(opening, /\bsrc\s*=/i, 'scripts must be inline');
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
      assert.match(html, /location\.replace\(location\.origin \+ '\/__openauri_retry'\)/);
      assert.match(html, /id="retry" href="\/__openauri_retry"/);
    }
  });
}
