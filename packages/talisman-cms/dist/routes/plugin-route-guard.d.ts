import { MiddlewareHandler } from 'astro';

/**
 * Plugin endpoints and admin-path plugin pages need a CMS session unless the plugin marks them public.
 * Endpoints answer 401 JSON and pages redirect to the admin sign-in. The route handler still applies its
 * own role checks. The guard loads the auth adapter only for protected plugin routes.
 */
declare const onRequest: MiddlewareHandler;

export { onRequest };
