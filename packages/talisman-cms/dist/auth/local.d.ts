import { T as TalismanAuthAdapter } from '../types-C5a-hx5D.js';
import { T as TalismanEnv } from '../client-Ccx_f4Il.js';
export { getAccessEmail } from './access.js';
import 'astro';
import 'drizzle-orm/d1';
import 'drizzle-orm';
import '../actor-Daa_hmny.js';

type LocalEnv = TalismanEnv & {
    TALISMAN_AUTH_SECRET?: string;
    TALISMAN_AUTH_SETUP_TOKEN?: string;
    TALISMAN_ACCESS_TEAM_DOMAIN?: string;
    TALISMAN_ACCESS_AUDIENCE?: string;
    TALISMAN_ACCESS_ADMIN_EMAILS?: string;
};
declare function getLocalAuthEnv(): Promise<LocalEnv>;
/**
 * Exchange a verified Cloudflare Access admin identity for a CMS session. The session is minted by the
 * `cloudflareAccessSignIn` endpoint, which verifies the Access JWT from the forwarded headers itself,
 * so no password is involved and the auth secret signs cookies and nothing else. Only the JWT, the
 * client IP and the user agent are forwarded: the endpoint takes no body.
 */
declare function signInCloudflareAdmin(request: Request, adminPath?: string): Promise<Response>;
declare function createInitialAdmin(request: Request, env: LocalEnv, adminPath: string, details: {
    email: string;
    name: string;
    password: string;
}): Promise<void>;
/**
 * Local CMS accounts on D1. The integration passes its admin path when it loads the adapter in the
 * Worker, so `adminPath` is optional; one that differs from the integration's fails the build.
 */
declare function LocalAuthAdapter(adminPath?: string, options?: {
    requireAccess?: boolean;
    editorOnly?: boolean;
}): TalismanAuthAdapter;
/** `/admin` when unset, `/` for a root admin, otherwise a leading slash and no trailing one. */
declare function normalizeAuthAdminPath(adminPath?: string): string;

export { LocalAuthAdapter, createInitialAdmin, getLocalAuthEnv, normalizeAuthAdminPath, signInCloudflareAdmin };
