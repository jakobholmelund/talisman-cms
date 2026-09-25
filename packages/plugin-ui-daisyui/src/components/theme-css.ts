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

/** daisyUI colour tokens the Theme Builder edits; each becomes `--color-<key>`. */
export const DAISYUI_THEME_COLOR_KEYS: readonly string[] = [
  'primary', 'primary-content', 'secondary', 'secondary-content', 'accent', 'accent-content',
  'neutral', 'neutral-content', 'base-100', 'base-200', 'base-300', 'base-content',
  'info', 'info-content', 'success', 'success-content', 'warning', 'warning-content',
  'error', 'error-content',
];

/** Theme Builder "advanced" settings and the daisyUI variables they set. */
export const DAISYUI_THEME_ADVANCED_VARS: Readonly<Record<string, string>> = {
  'rounded-box': '--radius-box', 'rounded-btn': '--radius-field', 'rounded-badge': '--radius-selector',
  'animation-btn': '--animation-btn', 'animation-input': '--animation-input', 'btn-focus-scale': '--btn-focus-scale',
  'border-btn': '--border', 'tab-border': '--tab-border', 'tab-radius': '--tab-radius',
};

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
  const isAdvancedKey = (key: string) => Object.prototype.hasOwnProperty.call(DAISYUI_THEME_ADVANCED_VARS, key);

  for (const [key, value] of Object.entries(input)) {
    if (key === 'lightTheme' || key === 'darkTheme') {
      if (isEmpty(value)) continue;
      if (isSafeThemeName(value)) settings[key] = value;
      else rejected.push(key);
    } else if (key === 'lightColors' || key === 'darkColors') {
      const colors = sanitizeGroup(value, key, isColorKey, isSafeThemeColor, rejected);
      if (colors) settings[key] = colors;
    } else if (key === 'advanced') {
      const advanced = sanitizeGroup(value, key, isAdvancedKey, isSafeThemeNumber, rejected);
      if (advanced) settings.advanced = advanced;
    } else {
      rejected.push(key);
    }
  }

  return { settings, rejected };
}

/** Builds the theme override CSS from untrusted stored data. Invalid values are left out. */
export function buildThemeCss(input: unknown): { css: string; lightTheme: string; darkTheme: string } {
  const { settings } = sanitizeThemeSettings(input);
  const lightTheme = settings.lightTheme || 'light';
  const darkTheme = settings.darkTheme || 'dark';

  const colorVars = (colors: Record<string, string> = {}) => Object.entries(colors)
    .map(([key, value]) => `--color-${key}: ${value};`)
    .join(' ');
  const advanced = settings.advanced || {};
  const advancedVars = Object.keys(advanced)
    .map((key) => `${DAISYUI_THEME_ADVANCED_VARS[key]}: ${advanced[key]};`)
    .join(' ');

  const css = `
  :root { ${advancedVars} }
  [data-theme="${lightTheme}"] { ${colorVars(settings.lightColors)} }
  [data-theme="${darkTheme}"] { ${colorVars(settings.darkColors)} }
`;

  // Validated values never contain "<"; escape it anyway so nothing can close the <style> element.
  return { css: css.replace(/</g, '\\3c '), lightTheme, darkTheme };
}
