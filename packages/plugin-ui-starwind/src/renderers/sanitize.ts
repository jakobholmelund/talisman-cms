// Output helpers for renderers that place editor-supplied values in URL attributes.
// Astro escapes attribute quoting, but it does not check URL schemes.
// safeHref is kept in sync with plugin-ui-daisyui/src/renderers/sanitize.ts.

const SAFE_URL_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

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
