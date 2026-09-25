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
/** Builds the theme override CSS from untrusted stored data. Invalid values are left out. */
declare function buildThemeCss(input: unknown): {
    css: string;
    lightTheme: string;
    darkTheme: string;
};

declare function daisyUiPlugin(): Plugin;

export { type DaisyUiThemeSettings, buildThemeCss, clampInteger, cssUrl, daisyUiPlugin, safeCssLength, safeHref, sanitizeThemeSettings };
