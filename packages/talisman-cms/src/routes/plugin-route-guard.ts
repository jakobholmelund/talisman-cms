import type { MiddlewareHandler } from 'astro';
import { adminPath, protectedRoutes } from 'virtual:talisman-cms/protected-routes';

/**
 * Plugin endpoints and admin-path plugin pages need a CMS session unless the plugin marks them public.
 * Endpoints answer 401 JSON and pages redirect to the admin sign-in. The route handler still applies its
 * own role checks. The guard module loads only for protected routes, so public pages never load the adapter.
 */
export const onRequest: MiddlewareHandler = async (context, next) => {
  const kind = Object.hasOwn(protectedRoutes, context.routePattern) ? protectedRoutes[context.routePattern] : undefined;
  if (!kind) return next();

  const { authorizeCmsRequest } = await import('../auth/guard');
  const authorization = await authorizeCmsRequest(context.request);
  if (!authorization.response) return next();
  if (kind === 'page' && authorization.response.status === 401) {
    return new Response(null, { status: 302, headers: { Location: adminPath, 'Cache-Control': 'no-store' } });
  }
  return authorization.response;
};
