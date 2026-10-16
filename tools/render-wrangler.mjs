import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

class RenderError extends Error {}

/** @param {string} source */
function parseEnv(source) {
  /** @type {Map<string, string>} */
  const values = new Map();
  for (const [index, raw] of source
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) throw new RenderError(`Invalid .env syntax at line ${index + 1}`);
    const [, key, remainder] = match;
    let value = remainder;
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const end = value.indexOf(quote, 1);
      if (end < 0 || !/^\s*(?:#.*)?$/.test(value.slice(end + 1))) {
        throw new RenderError(`Invalid .env syntax at line ${index + 1}`);
      }
      value = value.slice(1, end);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values.set(key, value);
  }
  return values;
}

function main() {
  const [template, output, ...extra] = process.argv.slice(2);
  if (!template || !output || extra.length) {
    throw new RenderError('Usage: node tools/render-wrangler.mjs <template> <output>');
  }
  let dotenv = '';
  try {
    dotenv = readFileSync(fileURLToPath(new URL('../.env', import.meta.url)), 'utf8');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw new RenderError('Could not read the repository .env file');
    }
  }
  const values = parseEnv(dotenv);
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) values.set(key, value);
  }
  let source;
  try {
    source = readFileSync(template, 'utf8');
  } catch {
    throw new RenderError('Could not read the Wrangler template');
  }
  const missing = new Set();
  const rendered = source.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => {
    const value = values.get(key);
    if (value === undefined || value === '') missing.add(key);
    return value ?? '';
  });
  if (missing.size) {
    throw new RenderError(`Missing environment variables: ${[...missing].sort().join(', ')}`);
  }
  const header = `// GENERATED — do not edit; source: ${template.replace(/[\r\n]/g, '')}\n`;
  try {
    writeFileSync(output, header + rendered, 'utf8');
  } catch {
    throw new RenderError('Could not write the generated Wrangler configuration');
  }
}

try {
  main();
} catch (error) {
  // Only controlled diagnostics may reach the terminal, never input or OS error text.
  console.error(error instanceof RenderError ? error.message : 'Could not render Wrangler config');
  process.exitCode = 1;
}
