import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MIN_WEBVIEW_VERSION } from '../../apps/android/capacitor.targets.mjs';
import { createArtifacts, deriveVersionCode } from '../../tools/android-artifacts.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8').replaceAll('\r\n', '\n');
const plan = read('docs/plans/2026-10-18-android-capacitor-plano.md');
const android = read('docs/android.md');
const runbook = 'docs/operacao/runbooks/android-release.md';

function section(source, heading) {
  const start = source.indexOf(`${heading}\n`);
  assert.notEqual(start, -1, `Missing section: ${heading}`);
  return source.slice(start + heading.length + 1).split(/\n(?:## |\*\*G\.)/)[0];
}

function quoted(source, pattern) {
  const matches = [...source.matchAll(pattern)];
  assert.equal(matches.length, 1, `Expected one notice matching ${pattern}`);
  return matches[0][1];
}

test('all npm run scripts cited by Android development and release docs exist', () => {
  const { scripts } = JSON.parse(read('package.json'));
  const sources = new Map([
    ['docs/android.md', android],
    ['docs/android/captura-usb.md', read('docs/android/captura-usb.md')],
    [
      'CONTRIBUTING.md (Android)',
      section(read('CONTRIBUTING.md'), '## Executar e testar o Android'),
    ],
    [runbook, read(runbook)],
  ]);
  let count = 0;
  for (const [path, source] of sources) {
    const citations = [...source.matchAll(/\bnpm\s+run\s+([\w:-]+)/g)];
    count += citations.length;
    for (const [, script] of citations) {
      assert.ok(Object.hasOwn(scripts, script), `${path}: unknown npm script ${script}`);
    }
  }
  assert.ok(count > 0, 'No npm script citations found in Android docs');
});

test('release runbook documents every secret and variable read by the Android release workflow', () => {
  const workflow = read('.github/workflows/android-release.yml');
  const names = new Set(
    [...workflow.matchAll(/\b(?:secrets|vars)\.([A-Za-z_][A-Za-z0-9_]*)\b/g)].map(
      (match) => match[1],
    ),
  );
  assert.ok(names.size > 0, 'No release workflow secrets or variables found');
  const source = read(runbook);
  for (const name of names) {
    assert.ok(source.includes(`\`${name}\``), `${runbook}: missing workflow setting ${name}`);
  }
});

test('backticked repository paths in docs/android.md exist on every checkout', () => {
  // Do not interpret fenced commands, URLs or the documented runtime endpoint as source files.
  const prose = android.replace(/^\s*```[^\n]*\n[\s\S]*?^\s*```/gm, '');
  const citations = [...prose.matchAll(/`([^`\n]+)`/g)]
    .map((match) => match[1])
    .filter((value) => /[/\\]/.test(value));
  assert.ok(citations.length > 0, 'No repository paths found');
  for (const citation of citations) {
    if (/^https?:\/\//.test(citation) || citation === '/_app/version.json') continue;
    // Published docs use a canonical Windows checkout path; map it to this checkout on Linux too.
    const path = citation.replaceAll('\\', '/').replace(/^D:\/git\/open-auri(?:\/|$)/i, '');
    const candidates = [resolve(root, path), resolve(root, 'docs', path)];
    assert.ok(
      candidates.some((candidate) => {
        const local = relative(root, candidate);
        return !local.startsWith(`..${sep}`) && local !== '..' && existsSync(candidate);
      }),
      `docs/android.md: missing repository path ${citation}`,
    );
  }
});

test('G.5 is verbatim in README, the Play listing and generated release notes', () => {
  const g5 = section(plan, '**G.5 Notas da release, README e ficha da Play**');
  const pt = quoted(g5, /^- pt-BR: "([^"]+)"$/gm);
  const en = quoted(g5, /^- en-US: "([^"]+)"$/gm);
  assert.equal(quoted(read('README.md'), /^> (Aviso: [^\n]+)$/gm), pt);
  const listing = read('docs/android/play-listing.md');
  for (const [language, notice] of [
    ['pt-BR', pt],
    ['en-US', en],
  ]) {
    const full = section(listing, `## ${language}`).match(
      /### Full description\n\n```text\n([^\n]+)/,
    );
    assert.ok(full, `${language}: missing full description`);
    assert.equal(full[1], notice, `${language}: Play notice differs from G.5`);
  }

  const pkg = JSON.parse(read('apps/android/package.json'));
  const fingerprint = 'ab'.repeat(32);
  const notes = createArtifacts(
    {
      apk: Buffer.from('apk'),
      aab: Buffer.from('aab'),
      apkName: 'open-auri.apk',
      aabName: 'open-auri.aab',
      expectedAppCertSha256: fingerprint,
      actualAppCertSha256: fingerprint,
      commit: '1234567890abcdef1234567890abcdef12345678',
      repoUrl: 'https://github.com/marco-jardim/open-auri',
      version: pkg.version,
      versionCode: deriveVersionCode(pkg.version),
    },
    {
      version: pkg.version,
      capacitorVersion: pkg.dependencies['@capacitor/android'],
      minWebViewVersion: MIN_WEBVIEW_VERSION,
      hardwareValidated: false,
    },
  )['RELEASE_NOTES.md'];
  assert.deepEqual(notes.split('\n\n').slice(0, 2), [pt, en]);
});

test('G.1 matches the Android doc and both site message locales exactly', () => {
  for (const language of ['pt-BR', 'en-US']) {
    const g1 = section(plan, `**G.1 Modal e banner (${language})**`);
    const text = quoted(g1, /^- \*\*Texto:\*\* "([^"]+)"$/gm);
    const messages = JSON.parse(read(`web/messages/${language}.json`));
    assert.equal(messages.android_untested_body, text, `${language}: site G.1 notice`);
    if (language === 'pt-BR') {
      const notice = section(android, '## Estado de validação: ainda não validado em hardware');
      assert.equal(quoted(notice, /^> (O app Android [^\n]+)$/gm), text);
      const title = quoted(g1, /^- \*\*Título:\*\* "([^"]+)"$/gm);
      assert.equal(quoted(notice, /^> \*\*([^\n]+)\*\*$/gm), title);
    }
  }
});

function textFiles(path) {
  return readdirSync(join(root, path), { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return textFiles(child);
    // Store artwork is binary; all other files are scanned, including new text formats.
    return /\.(?:png|jpe?g|webp|gif|ico|pdf)$/i.test(entry.name) ? [] : [child];
  });
}

test('Android docs, README, contributing, release runbook and issue templates have no U+2014', () => {
  const docs = readdirSync(join(root, 'docs'), { withFileTypes: true })
    .filter((entry) => entry.name.startsWith('android'))
    .flatMap((entry) =>
      entry.isDirectory() ? textFiles(join('docs', entry.name)) : [join('docs', entry.name)],
    );
  const paths = [
    ...docs,
    'README.md',
    'CONTRIBUTING.md',
    runbook,
    ...textFiles('.github/ISSUE_TEMPLATE'),
  ];
  for (const path of paths) assert.doesNotMatch(read(path), /\u2014/u, path);
});
