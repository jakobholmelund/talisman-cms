import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildThemeCss,
  clampInteger,
  cssUrl,
  safeCssLength,
  safeHref,
  sanitizeThemeSettings,
} from '../dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const renderersDir = path.join(packageRoot, 'src/renderers');

const HOSTILE_URLS = [
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  '  javascript:alert(1)',
  'java\tscript:alert(1)',
  'java\nscript:alert(1)',
  '\u0001javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
];

test('safeHref keeps http(s), mailto, tel, relative and fragment URLs', () => {
  for (const url of [
    'https://talisman.vision/shop',
    'HTTP://example.com',
    'mailto:hello@example.com',
    'tel:+4512345678',
    '/products/ring',
    'products/ring',
    '../up',
    '#details',
    '?page=2',
    '//cdn.example.com/image.png',
  ]) {
    assert.equal(safeHref(url), url);
  }
  assert.equal(safeHref('  /padded  '), '/padded');
});

test('safeHref replaces script and data URLs and non-strings with the fallback', () => {
  for (const url of HOSTILE_URLS) {
    assert.equal(safeHref(url), '#', url);
    assert.equal(safeHref(url, ''), '', url);
  }
  for (const value of [undefined, null, '', '   ', 42, {}, ['https://example.com']]) {
    assert.equal(safeHref(value), '#');
  }
  assert.equal(safeHref('javascript:alert(1)', '/'), '/');
});

test('cssUrl quotes and escapes URLs so they cannot end the declaration', () => {
  assert.equal(cssUrl('/api/media/media_1'), 'url("/api/media/media_1")');
  assert.equal(cssUrl('https://example.com/Foo_(bar).jpg'), 'url("https://example.com/Foo_\\28 bar\\29 .jpg")');

  const hostile = cssUrl('x");position:fixed;inset:0;background:url(https://evil.example/phish.png');
  assert.match(hostile, /^url\("[^"()]*"\)$/);
  assert.doesNotMatch(hostile.slice(5, -2), /["()]/);

  for (const url of HOSTILE_URLS) assert.equal(cssUrl(url), '', url);
  assert.equal(cssUrl(''), '');
});

test('safeCssLength accepts single lengths and rejects declarations', () => {
  for (const value of ['100%', '12rem', '1.5em', '240px', '0', 'auto', '50vh']) {
    assert.equal(safeCssLength(value, 'fallback'), value);
  }
  for (const value of ['1px;position:fixed', 'calc(100% - 1px)', 'url(x)', '10', '-5px', 12, null, '1rem}']) {
    assert.equal(safeCssLength(value, '1rem'), '1rem', String(value));
  }
});

test('clampInteger bounds loop counts and style numbers', () => {
  assert.equal(clampInteger(5, 1, 10, 5), 5);
  assert.equal(clampInteger('7', 1, 10, 5), 7);
  assert.equal(clampInteger(4294967296, 1, 10, 5), 10);
  assert.equal(clampInteger(1e8, 1, 10, 5), 10);
  assert.equal(clampInteger(-3, 1, 10, 5), 1);
  assert.equal(clampInteger(2.6, 0, 100, 0), 3);
  assert.equal(clampInteger('1;position:fixed', 0, 100, 75), 75);
  assert.equal(clampInteger(Infinity, 0, 100, 75), 75);
  assert.equal(clampInteger(undefined, 0, 100, 75), 75);
});

test('theme sanitising drops a <style> breakout and reports it', () => {
  const payload = {
    lightTheme: 'light"] {} </style><script>window.__xss_theme=1</script><style>',
    darkTheme: 'dark',
    lightColors: {
      primary: 'red;}</style><script>window.__xss_theme=1</script><style>',
      secondary: '#966fb3',
      'primary;}body{display:none': '#fff',
    },
    darkColors: { accent: 'oklch(73.95% 0.19 27.33)', neutral: 'rgb(0 0 0 / 50%)', info: 'url(https://evil.example/x)' },
    advanced: { 'rounded-box': '1rem;}body{display:none', 'rounded-btn': '0.5rem', 'btn-focus-scale': '0.95' },
    extra: 'ignored',
  };

  const { settings, rejected } = sanitizeThemeSettings(payload);
  assert.deepEqual(settings, {
    darkTheme: 'dark',
    lightColors: { secondary: '#966fb3' },
    darkColors: { accent: 'oklch(73.95% 0.19 27.33)', neutral: 'rgb(0 0 0 / 50%)' },
    advanced: { 'rounded-btn': '0.5rem', 'btn-focus-scale': '0.95' },
  });
  assert.deepEqual(rejected.sort(), [
    'advanced.rounded-box',
    'darkColors.info',
    'extra',
    'lightColors.primary',
    'lightColors.primary;}body{display:none',
    'lightTheme',
  ]);

  const { css, lightTheme, darkTheme } = buildThemeCss(payload);
  assert.equal(lightTheme, 'light');
  assert.equal(darkTheme, 'dark');
  assert.doesNotMatch(css, /<|script|display:none|evil|url\(/i);
  assert.match(css, /\[data-theme="light"\] \{ --color-secondary: #966fb3; \}/);
  assert.match(css, /:root \{ --radius-field: 0\.5rem; --btn-focus-scale: 0\.95; \}/);
});

test('theme sanitising accepts every value the Theme Builder ships with', () => {
  const colorKeys = new Set([
    'primary', 'primary-content', 'secondary', 'secondary-content', 'accent', 'accent-content',
    'neutral', 'neutral-content', 'base-100', 'base-200', 'base-300', 'base-content',
    'info', 'info-content', 'success', 'success-content', 'warning', 'warning-content', 'error', 'error-content',
  ]);
  const defaults = readFileSync(path.join(packageRoot, 'src/admin/themeDefaults.ts'), 'utf8');
  const colors = {};
  let count = 0;
  for (const [, key, value] of defaults.matchAll(/"([a-z0-9-]+)": "([^"]*)"/g)) {
    if (!colorKeys.has(key)) continue;
    colors[key] = value;
    const { rejected } = sanitizeThemeSettings({ lightTheme: 'aqua', lightColors: colors });
    assert.deepEqual(rejected, [], `${key}: ${value}`);
    count += 1;
  }
  assert.ok(count > 300, `expected the daisyUI palettes to be checked, saw ${count}`);

  const advanced = {
    'rounded-box': '1rem', 'rounded-btn': '0.5rem', 'rounded-badge': '1.9rem',
    'animation-btn': '0.25s', 'animation-input': '0.2s', 'btn-focus-scale': '0.95',
    'border-btn': '1px', 'tab-border': '1px', 'tab-radius': '0.5rem',
  };
  assert.deepEqual(sanitizeThemeSettings({ advanced }).rejected, []);
  assert.deepEqual(sanitizeThemeSettings({ lightColors: { primary: '', secondary: null } }), {
    settings: { lightColors: {} },
    rejected: [],
  });
});

test('every renderer href and src goes through safeHref', () => {
  for (const file of readdirSync(renderersDir).filter((name) => name.endsWith('.astro'))) {
    const source = readFileSync(path.join(renderersDir, file), 'utf8');
    for (const [, attribute, expression] of source.matchAll(/\b(href|src|srcset)=\{([^}]*)\}/g)) {
      const value = expression.trim();
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const isSanitised = value.startsWith('safeHref(')
        || new RegExp(`const ${escaped} = safeHref\\(`).test(source);
      assert.ok(isSanitised, `${file}: ${attribute}={${value}} is not passed through safeHref`);
    }
  }
});

test('style attributes only interpolate sanitised values', () => {
  const skeleton = readFileSync(path.join(renderersDir, 'DaisySkeletonBlock.astro'), 'utf8');
  const hero = readFileSync(path.join(renderersDir, 'DaisyHeroBanner.astro'), 'utf8');
  const rating = readFileSync(path.join(renderersDir, 'DaisyRatingStars.astro'), 'utf8');
  assert.match(skeleton, /safeCssLength\(width, '100%'\).*safeCssLength\(height, '1rem'\)/);
  assert.match(hero, /background-image: \$\{cssUrl\(imageSrc\)\}/);
  assert.match(rating, /Array\.from\(\{ length: starCount \}\)/);
  assert.match(rating, /const starCount = clampInteger\(max, 1, 10, 5\)/);

  const injector = readFileSync(path.join(packageRoot, 'src/components/DaisyUiThemeInjector.astro'), 'utf8');
  assert.match(injector, /buildThemeCss\(data\)/);
  assert.doesNotMatch(injector, /--color-\$\{key\}/);
});
