// State helpers for the Theme Builder, kept out of the React component so they can be tested.
//
// The builder only stores overrides: the values someone typed or picked. Everything else comes from
// the chosen base theme, which daisyUI itself provides, so saving without edits stores no colours and
// the site keeps daisyUI's own light and dark palettes.
import { DAISYUI_THEME_DEFAULTS } from './themeDefaults';
import { sanitizeThemeSettings, type DaisyUiThemeSettings } from '../components/theme-css';

export type ThemeMode = 'light' | 'dark';

export interface ThemeEditorState {
  lightTheme: string;
  darkTheme: string;
  lightColors: Record<string, string>;
  darkColors: Record<string, string>;
  advanced: Record<string, string>;
}

const hasOwn = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

/** Editor state for saved settings; anything missing or invalid starts as "no override". */
export function createThemeEditorState(saved: unknown): ThemeEditorState {
  const { settings } = sanitizeThemeSettings(saved);
  return {
    lightTheme: settings.lightTheme || 'light',
    darkTheme: settings.darkTheme || 'dark',
    lightColors: settings.lightColors || {},
    darkColors: settings.darkColors || {},
    advanced: settings.advanced || {},
  };
}

/**
 * The value daisyUI gives a colour (`primary`) or variable (`radius-box`) in a built-in theme, or
 * undefined for a theme daisyUI does not ship.
 */
export function themeDefaultValue(themeName: string, key: string): string | undefined {
  if (!hasOwn(DAISYUI_THEME_DEFAULTS, themeName)) return undefined;
  const { colors, vars } = DAISYUI_THEME_DEFAULTS[themeName];
  if (hasOwn(colors, key)) return colors[key];
  return hasOwn(vars, key) ? vars[key] : undefined;
}

/** Built-in themes for a mode, with the current theme first when it is not one of them. */
export function themeNamesFor(mode: ThemeMode, current: string): string[] {
  const names = Object.keys(DAISYUI_THEME_DEFAULTS).filter((name) => DAISYUI_THEME_DEFAULTS[name].colorScheme === mode);
  return current && !names.includes(current) ? [current, ...names] : names;
}

/** Trims a typed colour and adds the `#` to bare hex digits such as `ff0000`. */
export function normalizeColorInput(value: string): string {
  const text = value.trim();
  return /^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text) ? `#${text}` : text;
}

function compact(values: Record<string, string>, normalize: (value: string) => string) {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const text = normalize(value);
    if (text) output[key] = text;
  }
  return output;
}

/** The body the builder saves: the base themes plus the overrides that have a value. */
export function themeEditorPayload(state: ThemeEditorState): Required<DaisyUiThemeSettings> {
  return {
    lightTheme: state.lightTheme,
    darkTheme: state.darkTheme,
    lightColors: compact(state.lightColors, normalizeColorInput),
    darkColors: compact(state.darkColors, normalizeColorInput),
    advanced: compact(state.advanced, (value) => value.trim()),
  };
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const toHex = (channels: number[]) =>
  `#${channels.map((channel) => Math.round(clamp01(channel) * 255).toString(16).padStart(2, '0')).join('')}`;

function parseNumber(text: string | undefined, percentScale: number): number | null {
  if (text === 'none') return 0;
  if (!text) return null;
  const match = /^(-?(?:\d+|\d*\.\d+))(%|deg)?$/i.exec(text);
  if (!match) return null;
  const number = Number(match[1]);
  return match[2] === '%' ? (number / 100) * percentScale : number;
}

function oklchToSrgb(lightness: number, chroma: number, hue: number): number[] {
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return linear.map((channel) => (channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055));
}

/**
 * Converts a hex, `rgb()` or `oklch()` colour to the `#rrggbb` form that `<input type="color">`
 * needs, dropping alpha and clipping to sRGB. Returns null for anything else.
 */
export function colorToHex(value: string): string | null {
  const text = value.trim().toLowerCase();

  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
  if (hex) {
    const digits = hex[1].length <= 4 ? [...hex[1]].map((digit) => digit + digit).join('') : hex[1];
    return `#${digits.slice(0, 6)}`;
  }

  const fn = /^(rgba?|oklch)\(([^()]*)\)$/.exec(text);
  if (!fn) return null;
  const args = fn[2].split('/')[0].trim().split(/[\s,]+/);
  if (args.length !== 3) return null;

  if (fn[1] === 'oklch') {
    const [lightness, chroma, hue] = [parseNumber(args[0], 1), parseNumber(args[1], 0.4), parseNumber(args[2], 0)];
    if (lightness === null || chroma === null || hue === null) return null;
    return toHex(oklchToSrgb(lightness, chroma, hue));
  }

  const channels = args.map((arg) => parseNumber(arg, 255));
  if (channels.some((channel) => channel === null)) return null;
  return toHex((channels as number[]).map((channel) => channel / 255));
}
