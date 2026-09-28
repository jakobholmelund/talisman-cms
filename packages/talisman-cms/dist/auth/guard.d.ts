import { a as TalismanUser } from '../types-C5a-hx5D.js';
import { CmsAuthorization } from './authorize.js';
import 'astro';

/** Authenticate every private CMS endpoint, including routes injected by plugins. */
declare function authorizeCmsRequest(request: Request, requiredRole?: TalismanUser['role']): Promise<CmsAuthorization>;

export { authorizeCmsRequest };
