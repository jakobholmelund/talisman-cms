import { T as TalismanAuthAdapter } from '../types-C5a-hx5D.js';
import 'astro';

type AccessEnv = {
    TALISMAN_ACCESS_TEAM_DOMAIN?: string;
    TALISMAN_ACCESS_AUDIENCE?: string;
    TALISMAN_ACCESS_ADMIN_EMAILS?: string;
    TALISMAN_ACCESS_EDITOR_EMAILS?: string;
};
/** Verify the Access JWT at the Worker, including its signature, issuer and audience. */
declare function getAccessEmail(request: Request, env: AccessEnv): Promise<string | null | undefined>;
/**
 * Authenticate CMS users using a verified Cloudflare Access identity. The integration passes its admin
 * path when it loads the adapter in the Worker, so `adminPath` is optional; one that differs from the
 * integration's fails the build.
 */
declare function AccessAuthAdapter(adminPath?: string): TalismanAuthAdapter;

export { AccessAuthAdapter, getAccessEmail };
