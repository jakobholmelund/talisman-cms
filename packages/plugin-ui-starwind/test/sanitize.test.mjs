import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { safeHref } from '../dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const renderersDir = path.resolve(__dirname, '../src/renderers');

test('safeHref keeps http(s), mailto, tel, relative and fragment URLs', () => {
  for (const url of ['https://talisman.vision', 'mailto:hello@example.com', 'tel:+4512345678', '/about', 'about', '#team', '?q=1']) {
    assert.equal(safeHref(url), url);
  }
});

test('safeHref replaces script and data URLs and non-strings with the fallback', () => {
  for (const url of [
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    ' java\tscript:alert(1)',
    '\u0000javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
  ]) {
    assert.equal(safeHref(url), '#', url);
    assert.equal(safeHref(url, ''), '', url);
  }
  for (const value of [undefined, null, '', 42, {}]) {
    assert.equal(safeHref(value), '#');
  }
});

test('every Starwind renderer href and src goes through safeHref', () => {
  for (const file of readdirSync(renderersDir).filter((name) => name.endsWith('.astro'))) {
    const source = readFileSync(path.join(renderersDir, file), 'utf8');
    for (const [, attribute, expression] of source.matchAll(/\b(href|src)=\{([^}]*)\}/g)) {
      const value = expression.trim();
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const isSanitised = value.startsWith('safeHref(')
        || new RegExp(`const ${escaped} = safeHref\\(`).test(source);
      assert.ok(isSanitised, `${file}: ${attribute}={${value}} is not passed through safeHref`);
    }
  }
});
