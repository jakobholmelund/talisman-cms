import { privateResponse } from '../private-response';
import type { MiddlewareHandler } from 'astro';
import { adminPath, protectedRoutes } from 'virtual:talisman-cms/protected-routes';

const prefix = adminPath === '/' ? '' : adminPath;
const corePrivatePatterns = new Set([adminPath, `${prefix}/[...route]`, `${prefix}/api/[...route]`,
  ...['session', 'setup', '[...route]'].map(path => `${prefix}/api/auth/${path}`),
  `${prefix}/sso`, `${prefix}/api/media/upload`]);

/**
 * Plugin endpoints and admin-path plugin pages need a CMS session unless the plugin marks them public.
 * Endpoints answer 401 JSON and pages redirect to the admin sign-in. The route handler still applies its
 * own role checks. The guard loads the auth adapter only for protected plugin routes.
 */
export const onRequest: MiddlewareHandler = async (context, next) => {
  const kind = Object.hasOwn(protectedRoutes, context.routePattern) ? protectedRoutes[context.routePattern] : undefined;
  if (!kind) {
    const response = await next();
    return corePrivatePatterns.has(context.routePattern.replace(/\/$/, '') || '/') ? privateResponse(response) : response;
  }

  const { authorizeCmsRequest } = await import('../auth/guard');
  const authorization = await authorizeCmsRequest(context.request);
  if (!authorization.response) return privateResponse(await next());
  if (kind === 'page' && authorization.response.status === 401) {
    return privateResponse(new Response(null, { status: 302, headers: { Location: adminPath } }));
  }
  return authorization.response;
};
