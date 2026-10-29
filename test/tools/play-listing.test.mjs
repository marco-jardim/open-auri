import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const listing = read('../../docs/android/play-listing.md');
const requirements = read('../../docs/android/play-requisitos.md');
const plan = read('../../docs/plans/2026-10-18-android-capacitor-plano.md');
const contributing = read('../../CONTRIBUTING.md');

const languages = ['pt-BR', 'en-US'];
const limits = { Title: 30, 'Short description': 80, 'Full description': 4000 };
const requirementLabels = {
  Title: 'Título',
  'Short description': 'Descrição curta',
  'Full description': 'Descrição completa',
};
const notices = {
  'pt-BR':
    'Aviso: testamos a gravação num Kuba Auri com Galaxy A70 (Android 11), não em outros fabricantes. Prévia, gravação e restauração do Padrão Auri confirmadas pelo som; bytes na ponte nativa iguais aos do site no computador. Validação completa pendente. Som estranho? Grave Neutro; se não resolver, pelo site no computador (Chrome ou Edge). Relate: https://github.com/marco-jardim/open-auri/issues/new?template=android-cable-report.yml',
  'en-US':
    'Notice: writing tested on a Kuba Auri with Galaxy A70 (Android 11), not other manufacturers. Preview, writing and Padrão Auri restoration confirmed acoustically; native bridge bytes match the desktop site. Full validation pending. Sound off? Write Neutral; if unresolved, use the desktop site (Chrome or Edge). Report: https://github.com/marco-jardim/open-auri/issues/new?template=android-cable-report.yml',
};
const requiredPhrases = {
  'pt-BR': [
    'não é oficial nem endossado pela Kuba',
    'Use por sua conta e risco',
    'transporte USB nativo',
    'biblioteca',
    'compare respostas',
    'comunidade',
    'Android 8 ou mais recente',
    'Android System WebView atualizado',
    'Segurança dos dados (Data safety)',
    'dados coletados e compartilhados',
    '18 anos ou mais',
  ],
  'en-US': [
    'is not official or endorsed by Kuba',
    'Use at your own risk',
    'native USB transport',
    'library',
    'compare responses',
    'community',
    'Android 8 or newer',
    'up-to-date Android System WebView',
    'Data safety section of this listing',
    'collected and shared data',
    '18 or over',
  ],
};
const urls = [
  'https://open-auri.com',
  'https://open-auri.com/privacidade',
  'https://github.com/marco-jardim/open-auri',
  'https://github.com/marco-jardim/open-auri/issues/new?template=android-cable-report.yml',
];

function parseListing(source) {
  const result = new Map();
  for (const section of source.replace(/\r\n/g, '\n').split(/^## /m).slice(1)) {
    const [language, ...lines] = section.split('\n');
    if (!languages.includes(language)) continue;
    assert.ok(!result.has(language), `Duplicate language: ${language}`);
    const body = lines.join('\n');
    const blocks = [...body.matchAll(/^### ([^\n]+)\n\n```text\n([\s\S]*?)\n```(?=\n|$)/gm)];
    assert.deepEqual(
      blocks.map((block) => block[1]),
      Object.keys(limits),
      `${language}: exactly one text block per field`,
    );
    assert.equal((body.match(/^### /gm) ?? []).length, 3, `${language}: field headings`);
    assert.equal((body.match(/^```/gm) ?? []).length, 6, `${language}: no extra fenced blocks`);
    const fields = new Map(blocks.map((block) => [block[1], block[2]]));
    for (const [field, value] of fields) {
      assert.ok(value.length > 0, `${language}: empty ${field}`);
      assert.equal(value, value.trim(), `${language}: whitespace around ${field}`);
    }
    result.set(language, fields);
  }
  assert.deepEqual([...result.keys()], languages, 'Both languages must appear exactly once');
  return result;
}

test('both listing languages have exactly three fields within the documented Play limits', (t) => {
  const fieldsByLanguage = parseListing(listing);
  for (const [field, limit] of Object.entries(limits)) {
    const row = requirements.match(
      new RegExp(`^\\| ${requirementLabels[field]} \\| até ([\\d.]+) caracteres \\|`, 'm'),
    );
    assert.ok(row, `Missing requirement for ${field}`);
    assert.equal(Number(row[1].replaceAll('.', '')), limit, `Documented limit for ${field}`);
    for (const [language, fields] of fieldsByLanguage) {
      const length = [...fields.get(field)].length;
      assert.ok(length <= limit, `${language} ${field}: ${length} > ${limit}`);
      t.diagnostic(`${language} ${field}: ${length}/${limit} characters`);
    }
  }
  for (const fields of fieldsByLanguage.values()) assert.equal(fields.get('Title'), 'open-auri');
});

test('full descriptions start with the exact G.5 notices, also pinned to the plan', () => {
  const section = plan.match(/\*\*G\.5 [^\n]+\n([\s\S]*?)(?=\*\*G\.6 )/);
  assert.ok(section, 'Missing G.5 section in the plan');
  for (const [language, fields] of parseListing(listing)) {
    const notice = notices[language];
    assert.ok([...notice].length <= 500, `${language}: release notice exceeds Play limit`);
    assert.ok(
      section[1].includes(`- ${language}: "${notice}"`),
      `${language}: plan notice changed`,
    );
    assert.ok(
      fields.get('Full description').startsWith(`${notice}\n\n`),
      `${language}: full description must open with the verbatim G.5 paragraph`,
    );
  }
});

test('full descriptions retain legal, native USB, privacy, requirements and source information', () => {
  for (const [language, fields] of parseListing(listing)) {
    const full = fields.get('Full description');
    for (const phrase of [
      ...requiredPhrases[language],
      'Kuba Auri',
      'USB-C/OTG',
      'USB host/OTG',
      'AGPL-3.0',
    ]) {
      assert.ok(full.includes(phrase), `${language}: missing ${phrase}`);
    }
    const foundUrls = new Set(full.match(/https:\/\/[^\s]+/g));
    for (const url of urls) assert.ok(foundUrls.has(url), `${language}: missing URL ${url}`);
  }
});

test('short descriptions say unofficial and full descriptions lead with Android USB and independence', () => {
  const openings = {
    'pt-BR': ['Conecte o cabo Kuba Auri por USB-C/OTG', 'Projeto independente:'],
    'en-US': ['Connect the Kuba Auri cable through USB-C/OTG', 'Independent project:'],
  };
  for (const [language, fields] of parseListing(listing)) {
    assert.match(
      fields.get('Short description'),
      language === 'pt-BR' ? /não oficial/ : /unofficial/i,
    );
    const paragraphs = fields.get('Full description').split('\n\n');
    assert.ok(paragraphs[1].startsWith(openings[language][0]), `${language}: native USB first`);
    assert.ok(
      paragraphs[2].startsWith(openings[language][1]),
      `${language}: independence prominent`,
    );
    assert.doesNotMatch(
      fields.get('Full description'),
      /não coleta dados além|collects no data beyond/i,
    );
  }
});

test('shared fields contain category, tags, public contact placeholder and website URLs', () => {
  const shared = listing.split('## Campos compartilhados\n')[1]?.split('\n## ')[0];
  assert.ok(shared, 'Missing shared fields');
  for (const line of [
    '- Categoria: Music & Audio / Música e áudio',
    '- Tags sugeridas: equalização, áudio, ferramentas de áudio',
    '- E-mail de contato: contato público do desenvolvedor (definido no Play Console)',
    '- Site: https://open-auri.com',
    '- Política de privacidade: https://open-auri.com/privacidade',
  ]) {
    assert.ok(shared.split('\n').includes(line), `Missing shared field: ${line}`);
  }
  assert.doesNotMatch(listing, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, 'No real email address');
});

test('the entire listing has no U+2014 or branding forbidden by CONTRIBUTING', () => {
  assert.doesNotMatch(listing, /\u2014/u);
  const rule = contributing.match(
    /\*\*Marcas proibidas como branding:\*\* ([\s\S]*?)\.\s+Os nomes/,
  );
  assert.ok(rule, 'Missing forbidden branding rule');
  const brands = rule[1]
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/ e o logo da Kuba$/, ', logo da Kuba')
    .split(',')
    .flatMap((brand) => brand.trim().split('/'));
  assert.ok(brands.length > 0 && brands.every(Boolean), 'Forbidden brands must be parsed');
  const normalized = listing.replace(/\s+/g, ' ');
  for (const brand of brands) {
    const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu');
    assert.doesNotMatch(normalized, pattern, `Forbidden branding: ${brand}`);
  }
});

test('the listing parser rejects missing, duplicate, empty and extra fields', () => {
  for (const invalid of [
    listing.replace('## en-US', '## other'),
    `${listing}\n## pt-BR\n`,
    listing.replace('### Title', '### Short description'),
    listing.replace('```text\nopen-auri\n```', '```text\n\n```'),
    `${listing}\n\x60\x60\x60text\nextra\n\x60\x60\x60\n`,
  ]) {
    assert.throws(() => parseListing(invalid), assert.AssertionError);
  }
  assert.deepEqual(parseListing(listing.replace(/\n/g, '\r\n')), parseListing(listing));
});
