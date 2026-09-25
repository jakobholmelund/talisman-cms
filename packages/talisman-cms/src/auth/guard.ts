import { authAdapter, authConfigured } from 'virtual:talisman-cms/auth';
import type { TalismanUser } from './types';
import { authorizeCmsRequestWithAdapter, type CmsAuthorization } from './authorize';

/** Authenticate every private CMS endpoint, including routes injected by plugins. */
export async function authorizeCmsRequest(
  request: Request,
  requiredRole?: TalismanUser['role'],
): Promise<CmsAuthorization> {
  return authorizeCmsRequestWithAdapter(request, authAdapter, authConfigured, requiredRole);
}
