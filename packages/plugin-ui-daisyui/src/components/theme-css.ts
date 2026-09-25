// Validation and CSS output for the `daisyui-theme` global. Stored values end up inside a <style>
// element on the site origin, and editors can write the global through the core globals API too,
// so every value is checked against an allowlist here, both when saving and when rendering.

export interface DaisyUiThemeSettings {
  lightTheme?: string;
  darkTheme?: string;
  lightColors?: Record<string, string>;
  darkColors?: Record<string, string>;
  advanced?: Record<string, string>;
}

export interface DaisyUiThemeField {
  key: string;
  label: string;
}

/** daisyUI 5 colour tokens the Theme Builder edits; each becomes `--color-<key>`. */
export const DAISYUI_THEME_COLORS: readonly DaisyUiThemeField[] = [
  { key: 'primary', label: 'Primary' },
  { key: 'primary-content', label: 'Primary Content' },
  { key: 'secondary', label: 'Secondary' },
  { key: 'secondary-content', label: 'Secondary Content' },
  { key: 'accent', label: 'Accent' },
  { key: 'accent-content', label: 'Accent Content' },
  { key: 'neutral', label: 'Neutral' },
  { key: 'neutral-content', label: 'Neutral Content' },
  { key: 'base-100', label: 'Base 100' },
  { key: 'base-200', label: 'Base 200' },
  { key: 'base-300', label: 'Base 300' },
  { key: 'base-content', label: 'Base Content' },
  { key: 'info', label: 'Info' },
  { key: 'info-content', label: 'Info Content' },
  { key: 'success', label: 'Success' },
  { key: 'success-content', label: 'Success Content' },
  { key: 'warning', label: 'Warning' },
  { key: 'warning-content', label: 'Warning Content' },
  { key: 'error', label: 'Error' },
  { key: 'error-content', label: 'Error Content' },
];

export const DAISYUI_THEME_COLOR_KEYS: readonly string[] = DAISYUI_THEME_COLORS.map((field) => field.key);

/**
 * daisyUI 5 radius, size, border and effect variables the Theme Builder edits ("advanced"). Keys are
 * the variable names without the leading `--`. daisyUI sets them in every theme.
 */
export const DAISYUI_THEME_ADVANCED: readonly DaisyUiThemeField[] = [
  { key: 'radius-box', label: 'Radius: boxes (cards, modals, alerts)' },
  { key: 'radius-field', label: 'Radius: fields (buttons, inputs, selects, tabs)' },
  { key: 'radius-selector', label: 'Radius: selectors (checkboxes, toggles, badges)' },
  { key: 'size-field', label: 'Size: fields (buttons, inputs, selects, tabs)' },
  { key: 'size-selector', label: 'Size: selectors (checkboxes, toggles, badges)' },
  { key: 'border', label: 'Border width' },
  { key: 'depth', label: 'Depth effect (0 or 1)' },
  { key: 'noise', label: 'Noise effect (0 or 1)' },
];

export const DAISYUI_THEME_ADVANCED_KEYS: readonly string[] = DAISYUI_THEME_ADVANCED.map((field) => field.key);

// Advanced keys that earlier Theme Builder versions saved, named after daisyUI 4 variables. That
// builder filled them with its own defaults on the first save, so they are dropped, not reported.
const LEGACY_ADVANCED_KEYS: readonly string[] = [
  'rounded-box', 'rounded-btn', 'rounded-badge', 'border-btn',
  'animation-btn', 'animation-input', 'btn-focus-scale', 'tab-border', 'tab-radius',
];

const MAX_VALUE_LENGTH = 100;
const THEME_NAME = /^[a-z0-9_-]{1,64}$/i;
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// Colour functions with plain arguments only: no nested functions, quotes, semicolons or braces.
const FUNCTION_COLOR = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([a-z0-9.%+\-\/,\s]*\)$/i;
const NAMED_COLOR = /^[a-z]{3,32}$/i;
const CSS_NUMBER = /^-?(?:\d+|\d*\.\d+)(?:px|rem|em|%|s|ms|vh|vw|ch|ex)?$/i;

function toValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length <= MAX_VALUE_LENGTH ? trimmed : null;
}

export function isSafeThemeName(value: unknown): value is string {
  return typeof value === 'string' && THEME_NAME.test(value);
}

export function isSafeThemeColor(value: unknown): boolean {
  const text = toValue(value);
  return !!text && (HEX_COLOR.test(text) || FUNCTION_COLOR.test(text) || NAMED_COLOR.test(text));
}

export function isSafeThemeNumber(value: unknown): boolean {
  const text = toValue(value);
  return !!text && CSS_NUMBER.test(text);
}

function isEmpty(value: unknown) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeGroup(
  input: unknown,
  path: string,
  isAllowedKey: (key: string) => boolean,
  isSafe: (value: unknown) => boolean,
  rejected: string[],
): Record<string, string> | undefined {
  if (input === undefined || input === null) return undefined;
  if (!isRecord(input)) {
    rejected.push(path);
    return undefined;
  }

  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (isEmpty(value)) continue;
    if (isAllowedKey(key) && isSafe(value)) output[key] = toValue(value) as string;
    else rejected.push(`${path}.${key}`);
  }
  return output;
}

/**
 * Keeps only known keys whose values pass the allowlist. Empty values are dropped silently;
 * every other dropped key is listed in `rejected` so the API can refuse the save.
 */
export function sanitizeThemeSettings(input: unknown): { settings: DaisyUiThemeSettings; rejected: string[] } {
  const rejected: string[] = [];
  const settings: DaisyUiThemeSettings = {};
  if (!isRecord(input)) return { settings, rejected: isEmpty(input) ? rejected : ['(root)'] };

  const isColorKey = (key: string) => DAISYUI_THEME_COLOR_KEYS.includes(key);
  const isAdvancedKey = (key: string) => DAISYUI_THEME_ADVANCED_KEYS.includes(key);

  for (const [key, value] of Object.entries(input)) {
    if (key === 'lightTheme' || key === 'darkTheme') {
      if (isEmpty(value)) continue;
      if (isSafeThemeName(value)) settings[key] = value;
      else rejected.push(key);
    } else if (key === 'lightColors' || key === 'darkColors') {
      const colors = sanitizeGroup(value, key, isColorKey, isSafeThemeColor, rejected);
      if (colors) settings[key] = colors;
    } else if (key === 'advanced') {
      const current = isRecord(value)
        ? Object.fromEntries(Object.entries(value).filter(([name]) => !LEGACY_ADVANCED_KEYS.includes(name)))
        : value;
      const advanced = sanitizeGroup(current, key, isAdvancedKey, isSafeThemeNumber, rejected);
      if (advanced) settings.advanced = advanced;
    } else {
      rejected.push(key);
    }
  }

  return { settings, rejected };
}

/**
 * Builds the theme override CSS from untrusted stored data. Invalid values are left out, and the CSS
 * is empty when nothing is overridden, so the base themes apply unchanged.
 */
export function buildThemeCss(input: unknown): { css: string; lightTheme: string; darkTheme: string } {
  const { settings } = sanitizeThemeSettings(input);
  const lightTheme = settings.lightTheme || 'light';
  const darkTheme = settings.darkTheme || 'dark';

  // daisyUI 5 sets the radius, size and effect variables in each theme's own rule, so they go into
  // both theme rules rather than on :root.
  const advancedVars = Object.entries(settings.advanced || {}).map(([key, value]) => `--${key}: ${value};`);
  const themeRule = (theme: string, colors: Record<string, string> = {}) => {
    const declarations = [
      ...Object.entries(colors).map(([key, value]) => `--color-${key}: ${value};`),
      ...advancedVars,
    ];
    // Tailwind's @plugin "daisyui" puts the themes in @layer base, which these unlayered rules beat.
    // daisyUI's standalone themes.css is unlayered and usually loads after this <style>; the repeated
    // attribute selector outranks its [data-theme=name] rules too.
    return declarations.length > 0 ? `[data-theme="${theme}"][data-theme] { ${declarations.join(' ')} }` : '';
  };

  const css = [themeRule(lightTheme, settings.lightColors), themeRule(darkTheme, settings.darkColors)]
    .filter(Boolean)
    .join('\n');

  // Validated values never contain "<"; escape it anyway so nothing can close the <style> element.
  return { css: css.replace(/</g, '\\3c '), lightTheme, darkTheme };
}
