import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DAISYUI_THEME_DEFAULTS,
  buildThemeCss,
  colorToHex,
  createThemeEditorState,
  daisyUiPlugin,
  sanitizeThemeSettings,
  themeDefaultValue,
  themeEditorPayload,
} from '../dist/index.js';
import { loadDaisyUiThemes, renderThemeDefaults, themeDefaultsPath } from '../scripts/theme-defaults.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');

const COLOR_KEYS = [
  'primary', 'primary-content', 'secondary', 'secondary-content', 'accent', 'accent-content',
  'neutral', 'neutral-content', 'base-100', 'base-200', 'base-300', 'base-content',
  'info', 'info-content', 'success', 'success-content', 'warning', 'warning-content', 'error', 'error-content',
];
const ADVANCED_KEYS = [
  'radius-box', 'radius-field', 'radius-selector', 'size-field', 'size-selector', 'border', 'depth', 'noise',
];

test('theme defaults are daisyUI 5 themes with every colour and variable', () => {
  const names = Object.keys(DAISYUI_THEME_DEFAULTS);
  assert.equal(names.length, 35);
  assert.deepEqual(names.slice(0, 2), ['light', 'dark']);
  for (const name of ['silk', 'caramellatte', 'abyss']) assert.ok(names.includes(name), name);

  for (const [name, theme] of Object.entries(DAISYUI_THEME_DEFAULTS)) {
    assert.ok(theme.colorScheme === 'light' || theme.colorScheme === 'dark', name);
    assert.deepEqual(Object.keys(theme.colors).sort(), [...COLOR_KEYS].sort(), name);
    assert.deepEqual(Object.keys(theme.vars).sort(), [...ADVANCED_KEYS].sort(), name);
  }

  // daisyUI 5 values, not the daisyUI 4 ones the builder used to ship (oklch(49.12% 0.3096 275.75)).
  assert.equal(themeDefaultValue('light', 'primary'), 'oklch(45% 0.24 277.023)');
  assert.equal(themeDefaultValue('dark', 'base-100'), 'oklch(25.33% 0.016 252.42)');
  assert.equal(themeDefaultValue('light', 'radius-box'), '0.5rem');
  assert.equal(themeDefaultValue('my-brand', 'primary'), undefined);
  assert.equal(themeDefaultValue('constructor', 'primary'), undefined);
  assert.equal(themeDefaultValue('light', 'toString'), undefined);
});

test('themeDefaults.ts matches the daisyUI installed in the workspace', async (t) => {
  const daisyUi = await loadDaisyUiThemes();
  if (!daisyUi) {
    t.skip('daisyUI is not installed next to this package');
    return;
  }
  assert.equal(
    readFileSync(themeDefaultsPath, 'utf8'),
    renderThemeDefaults(daisyUi),
    `src/admin/themeDefaults.ts is stale for daisyui@${daisyUi.version}; run pnpm run theme-defaults`,
  );
});

test('a first save keeps the base themes: no colour or variable overrides are stored', () => {
  for (const saved of [{}, undefined, null, '']) {
    const state = createThemeEditorState(saved);
    assert.deepEqual(state, { lightTheme: 'light', darkTheme: 'dark', lightColors: {}, darkColors: {}, advanced: {} });

    const payload = themeEditorPayload(state);
    assert.deepEqual(sanitizeThemeSettings(payload).rejected, []);
    // Nothing is overridden, so the injector emits no CSS and dark mode keeps daisyUI's dark palette.
    assert.equal(buildThemeCss(payload).css, '');
  }
});

test('the editor keeps saved overrides and drops daisyUI 4 advanced settings', () => {
  const state = createThemeEditorState({
    lightTheme: 'cupcake',
    darkTheme: 'dracula',
    darkColors: { primary: 'oklch(70% 0.2 300)' },
    advanced: {
      'radius-box': '0.75rem',
      'rounded-badge': '1.9rem',
      'animation-btn': '0.25s',
      'btn-focus-scale': '0.95',
      'tab-radius': '0.5rem',
    },
  });
  assert.deepEqual(state, {
    lightTheme: 'cupcake',
    darkTheme: 'dracula',
    lightColors: {},
    darkColors: { primary: 'oklch(70% 0.2 300)' },
    advanced: { 'radius-box': '0.75rem' },
  });

  const { css } = buildThemeCss(themeEditorPayload(state));
  assert.equal(css, [
    '[data-theme="cupcake"][data-theme] { --radius-box: 0.75rem; }',
    '[data-theme="dracula"][data-theme] { --color-primary: oklch(70% 0.2 300); --radius-box: 0.75rem; }',
  ].join('\n'));
  assert.doesNotMatch(css, /:root|animation|focus-scale|tab-/);
});

test('the save payload drops cleared fields and fixes bare hex colours', () => {
  const payload = themeEditorPayload({
    lightTheme: 'light',
    darkTheme: 'dark',
    lightColors: { primary: 'ff0000', secondary: '  ', accent: ' oklch(77% 0.152 181.912) ' },
    darkColors: { 'base-100': '#1d232a' },
    advanced: { border: ' 2px ', depth: '' },
  });
  assert.deepEqual(payload, {
    lightTheme: 'light',
    darkTheme: 'dark',
    lightColors: { primary: '#ff0000', accent: 'oklch(77% 0.152 181.912)' },
    darkColors: { 'base-100': '#1d232a' },
    advanced: { border: '2px' },
  });
  assert.deepEqual(sanitizeThemeSettings(payload).rejected, []);
});

test('colorToHex gives the colour picker a #rrggbb value for daisyUI colours', () => {
  assert.equal(colorToHex('oklch(100% 0 0)'), '#ffffff');
  assert.equal(colorToHex('oklch(0% 0 0)'), '#000000');
  assert.equal(colorToHex('oklch(62.796% 0.25768 29.2339)'), '#ff0000');
  assert.equal(colorToHex('oklch(58% 0.233 277.117 / 50%)'), '#605dff');
  assert.equal(colorToHex('#abc'), '#aabbcc');
  assert.equal(colorToHex('#11223344'), '#112233');
  assert.equal(colorToHex('rgb(255 0 0)'), '#ff0000');
  assert.equal(colorToHex('rgb(10%, 20%, 30%)'), '#1a334d');
  for (const value of ['red', '', 'oklch(1 2)', 'hsl(0 100% 50%)', '#oklch(45% 0.24 277)']) {
    assert.equal(colorToHex(value), null, value);
  }
  for (const theme of Object.values(DAISYUI_THEME_DEFAULTS)) {
    for (const value of Object.values(theme.colors)) assert.match(colorToHex(value) ?? '', /^#[0-9a-f]{6}$/, value);
  }
});

test('the daisyui-theme global declares the keys the Theme Builder saves, without defaults', () => {
  const config = daisyUiPlugin().onInit({ globals: [] });
  const global = config.globals.find((entry) => entry.slug === 'daisyui-theme');
  const group = (name) => global.fields.find((field) => field.name === name).fields;

  assert.deepEqual(group('lightColors').map((field) => field.name), COLOR_KEYS);
  assert.deepEqual(group('darkColors').map((field) => field.name), COLOR_KEYS);
  assert.deepEqual(group('advanced').map((field) => field.name), ADVANCED_KEYS);
  for (const name of ['lightColors', 'darkColors', 'advanced']) {
    for (const field of group(name)) assert.equal(field.defaultValue, undefined, `${name}.${field.name}`);
  }
});

test('the Theme Builder loads state through createThemeEditorState and seeds no palette', () => {
  const source = readFileSync(path.join(packageRoot, 'src/admin/ThemeBuilder.tsx'), 'utf8');
  assert.match(source, /applyState\(createThemeEditorState\(data\)\)/);
  assert.match(source, /JSON\.stringify\(payload\(\)\)/);
  // No hardcoded palette: the old builder saved '#570df8' and friends as overrides for both modes.
  assert.doesNotMatch(source, /#570df8|default: '#/i);
  assert.doesNotMatch(source, /'#' \+/);

  const preview = readFileSync(path.join(packageRoot, 'src/components/DaisyUiPreviewContent.astro'), 'utf8');
  assert.match(preview, /buildThemeCss\(JSON\.parse\(stateStr\)\)/);
  assert.doesNotMatch(preview, /is:inline/);
});
