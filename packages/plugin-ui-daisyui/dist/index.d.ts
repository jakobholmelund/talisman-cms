import { Plugin } from 'talisman-cms';
export { daisyUiLibrary } from './generated.js';

/**
 * Returns the URL when it is relative, a fragment, or uses http(s), mailto or tel.
 * Anything else, such as javascript:, data: or vbscript:, becomes `fallback`.
 */
declare function safeHref(value: unknown, fallback?: string): string;
/** Builds a quoted CSS `url("...")` for a safe URL, or returns '' when the URL is unsafe or empty. */
declare function cssUrl(value: unknown): string;
/** Accepts a single CSS length such as `100%`, `12rem` or `auto`; anything else becomes `fallback`. */
declare function safeCssLength(value: unknown, fallback: string): string;
/** Coerces a numeric prop to an integer in [min, max], using `fallback` for non-numeric input. */
declare function clampInteger(value: unknown, min: number, max: number, fallback: number): number;

interface DaisyUiThemeSettings {
    lightTheme?: string;
    darkTheme?: string;
    lightColors?: Record<string, string>;
    darkColors?: Record<string, string>;
    advanced?: Record<string, string>;
}
/**
 * Keeps only known keys whose values pass the allowlist. Empty values are dropped silently;
 * every other dropped key is listed in `rejected` so the API can refuse the save.
 */
declare function sanitizeThemeSettings(input: unknown): {
    settings: DaisyUiThemeSettings;
    rejected: string[];
};
/**
 * Builds the theme override CSS from untrusted stored data. Invalid values are left out, and the CSS
 * is empty when nothing is overridden, so the base themes apply unchanged.
 */
declare function buildThemeCss(input: unknown): {
    css: string;
    lightTheme: string;
    darkTheme: string;
};

interface DaisyUiThemeDefaults {
    colorScheme: 'light' | 'dark';
    /** `--color-<key>` values, keyed without the `--color-` prefix. */
    colors: Record<string, string>;
    /** Radius, size, border, depth and noise variables, keyed without the leading `--`. */
    vars: Record<string, string>;
}
/** The daisyUI release these values were generated from. */
declare const DAISYUI_THEME_DEFAULTS_VERSION = "5.7.42";
/** daisyUI's built-in themes, in daisyUI's own order. */
declare const DAISYUI_THEME_DEFAULTS: Record<string, DaisyUiThemeDefaults>;

interface ThemeEditorState {
    lightTheme: string;
    darkTheme: string;
    lightColors: Record<string, string>;
    darkColors: Record<string, string>;
    advanced: Record<string, string>;
}
/** Editor state for saved settings; anything missing or invalid starts as "no override". */
declare function createThemeEditorState(saved: unknown): ThemeEditorState;
/**
 * The value daisyUI gives a colour (`primary`) or variable (`radius-box`) in a built-in theme, or
 * undefined for a theme daisyUI does not ship.
 */
declare function themeDefaultValue(themeName: string, key: string): string | undefined;
/** The body the builder saves: the base themes plus the overrides that have a value. */
declare function themeEditorPayload(state: ThemeEditorState): Required<DaisyUiThemeSettings>;
/**
 * Converts a hex, `rgb()` or `oklch()` colour to the `#rrggbb` form that `<input type="color">`
 * needs, dropping alpha and clipping to sRGB. Returns null for anything else.
 */
declare function colorToHex(value: string): string | null;

declare function daisyUiPlugin(): Plugin;

export { DAISYUI_THEME_DEFAULTS, DAISYUI_THEME_DEFAULTS_VERSION, type DaisyUiThemeDefaults, type DaisyUiThemeSettings, type ThemeEditorState, buildThemeCss, clampInteger, colorToHex, createThemeEditorState, cssUrl, daisyUiPlugin, safeCssLength, safeHref, sanitizeThemeSettings, themeDefaultValue, themeEditorPayload };
