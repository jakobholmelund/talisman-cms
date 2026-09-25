import { a as TalismanUser, T as TalismanAuthAdapter } from '../types-B9Ys5hZL.js';
import 'astro';

type CmsAuthorization = {
    user: TalismanUser;
    response?: never;
} | {
    user?: never;
    response: Response;
};
declare function authorizeCmsRequestWithAdapter(request: Request, authAdapter: TalismanAuthAdapter | null, authConfigured: boolean, requiredRole?: TalismanUser['role']): Promise<CmsAuthorization>;

export { type CmsAuthorization, authorizeCmsRequestWithAdapter };
