import { T as TalismanAuthAdapter } from '../types-B9Ys5hZL.js';
import 'astro';

type AccessEnv = {
    TALISMAN_ACCESS_TEAM_DOMAIN?: string;
    TALISMAN_ACCESS_AUDIENCE?: string;
    TALISMAN_ACCESS_ADMIN_EMAILS?: string;
    TALISMAN_ACCESS_EDITOR_EMAILS?: string;
};
/** Verify the Access JWT at the Worker, including its signature, issuer and audience. */
declare function getAccessEmail(request: Request, env: AccessEnv): Promise<string | null | undefined>;
/** Authenticate CMS users using a verified Cloudflare Access identity. */
declare function AccessAuthAdapter(adminPath?: string): TalismanAuthAdapter;

export { AccessAuthAdapter, getAccessEmail };
