export { starwindUiLibrary, starwindUiPlugin } from './generated.js';
import 'talisman-cms';

/**
 * Returns the URL when it is relative, a fragment, or uses http(s), mailto or tel.
 * Anything else, such as javascript:, data: or vbscript:, becomes `fallback`.
 */
declare function safeHref(value: unknown, fallback?: string): string;

export { safeHref };
