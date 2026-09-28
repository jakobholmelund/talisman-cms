// The admin SDK for plugin screens, imported as `talisman-cms/ui/sdk`: the admin path, URLs under
// it, JSON requests to plugin endpoints, the settings the admin page exposes and the signed-in
// user. It ships as source like the rest of ui/, because it reads the site's config module.
import { useRouter } from '@tanstack/react-router';
import { adminPath as configuredAdminPath } from 'virtual:talisman-cms/config';
import type { RouterContext } from './routerContext';

/** `readAdminSetting(name)` reads a setting a plugin exposed with `adminSettings` from the admin page's meta tags. */
export { readAdminSetting } from './lib/entry-labels';

/**
 * The admin path as the site configured it: `/admin` by default, `/` for an admin at the site root,
 * otherwise a path such as `/cms`. Never ends with a slash.
 */
export const adminPath: string = configuredAdminPath || '/admin';

function withoutLeadingSlashes(path: string) {
  return path.replace(/^\/+/, '');
}

/**
 * A URL under the admin path. `adminUrl('extensions/orders')` is `/admin/extensions/orders` under
 * the default admin path and `/extensions/orders` for an admin at the site root; `adminUrl()` is the
 * admin path itself. A leading slash on the argument is tolerated and not doubled.
 */
export function adminUrl(path = ''): string {
  const relative = withoutLeadingSlashes(path);
  if (!relative) return adminPath;
  return adminPath === '/' ? `/${relative}` : `${adminPath}/${relative}`;
}

/** The URL of an admin API route: `adminApiUrl('ecommerce/orders')` is `/admin/api/ecommerce/orders`. */
export function adminApiUrl(path: string): string {
  return adminUrl(`api/${withoutLeadingSlashes(path)}`);
}

export interface AdminRequestInit {
  /** The HTTP method: POST with a body and GET without, unless given. */
  method?: string;
  /** Sent as JSON with `Content-Type: application/json`. */
  body?: unknown;
  signal?: AbortSignal;
  /** Extra request headers. */
  headers?: Record<string, string>;
}

/**
 * A JSON request to an admin API route with the CMS session. `adminRequest('ecommerce/orders', { body })`
 * posts the body as JSON to `adminApiUrl('ecommerce/orders')` and returns the parsed answer. A response
 * that is not ok throws an Error with the answer's `error` text, or "Request failed" without one. An
 * answer without a JSON body, such as a gateway's error page, is read as null.
 */
export async function adminRequest<T>(path: string, init: AdminRequestInit = {}): Promise<T> {
  const hasBody = init.body !== undefined;
  const response = await fetch(adminApiUrl(path), {
    method: init.method || (hasBody ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: hasBody ? { 'Content-Type': 'application/json', ...init.headers } : init.headers,
    body: hasBody ? JSON.stringify(init.body) : undefined,
    signal: init.signal,
  });
  const result = (await response.json().catch(() => null)) as (T & { error?: unknown }) | null;
  if (!response.ok) {
    throw new Error(typeof result?.error === 'string' && result.error ? result.error : 'Request failed');
  }
  return result as T;
}

/** The signed-in user from the admin's router context, or null before sign-in. */
export function useAdminUser(): { role?: string; email?: string } | null {
  const context = useRouter().options.context as RouterContext | undefined;
  return context?.user ?? null;
}
