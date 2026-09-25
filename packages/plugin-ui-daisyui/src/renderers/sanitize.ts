// Output helpers for renderers that place editor-supplied values in URL or style attributes.
// Astro escapes attribute quoting, but it does not check URL schemes or CSS syntax.
// safeHref is kept in sync with plugin-ui-starwind/src/renderers/sanitize.ts.

const SAFE_URL_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
const CSS_LENGTH = /^(?:0|(?:\d+|\d*\.\d+)(?:px|rem|em|%|vh|vw|vmin|vmax|ch|ex)|auto)$/i;

/**
 * Returns the URL when it is relative, a fragment, or uses http(s), mailto or tel.
 * Anything else, such as javascript:, data: or vbscript:, becomes `fallback`.
 */
export function safeHref(value: unknown, fallback = '#'): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;

  // Browsers drop control characters and whitespace while reading a scheme, so "java\tscript:" still runs.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed.replace(/[\u0000- \u007f-\u009f]/g, ''));
  if (!scheme) return trimmed;
  return SAFE_URL_SCHEMES.has(scheme[1].toLowerCase()) ? trimmed : fallback;
}

/** Builds a quoted CSS `url("...")` for a safe URL, or returns '' when the URL is unsafe or empty. */
export function cssUrl(value: unknown): string {
  const href = safeHref(value, '');
  if (!href) return '';
  const escaped = href.replace(/[\\"'()<>\u0000-\u001f\u007f]/g, (char) => `\\${char.charCodeAt(0).toString(16)} `);
  return `url("${escaped}")`;
}

/** Accepts a single CSS length such as `100%`, `12rem` or `auto`; anything else becomes `fallback`. */
export function safeCssLength(value: unknown, fallback: string): string {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  return CSS_LENGTH.test(text) ? text : fallback;
}

/** Coerces a numeric prop to an integer in [min, max], using `fallback` for non-numeric input. */
export function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}
