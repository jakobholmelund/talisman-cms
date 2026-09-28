import * as better_auth from 'better-auth';

/** The endpoint's path inside better-auth. It is never in the auth proxy's allowlist, so HTTP cannot reach it. */
declare const CLOUDFLARE_ACCESS_SIGN_IN_PATH = "/sign-in/cloudflare-access";
interface CloudflareAccessSignInOptions {
    /** Verifies the Access JWT in the request headers and returns its email, or null when it is missing or invalid. */
    verify: (headers: Headers) => Promise<string | null | undefined>;
    /** The lower-cased emails allowed to sign in as admin. */
    allowed: () => Set<string>;
    /** Sessions older than this are dead whatever their expiry (the CMS caps a session's age); they are pruned at sign-in. */
    maxSessionAgeMs: number;
}
/**
 * A better-auth plugin with one endpoint, `POST /sign-in/cloudflare-access`, that exchanges a verified
 * Cloudflare Access identity for a CMS session without a password. The endpoint reads the Access JWT
 * from the request headers and verifies it itself, so nothing a caller sends can name the account. It
 * finds or creates the admin row, deletes any password credential the row has (an SSO-managed admin has
 * none; this also retires the derived credentials an earlier version stored), and creates the session
 * with `authMethod` set to `cloudflare` at creation. The admin's live sessions are left alone; the ones
 * that have expired or passed the age cap are pruned, so the row count per admin stays bounded. The
 * endpoint is server-only: better-auth's HTTP router never registers it.
 */
declare function cloudflareAccessSignIn(options: CloudflareAccessSignInOptions): {
    id: "talisman-cloudflare-access";
    endpoints: {
        signInCloudflareAccess: better_auth.StrictEndpoint<"/sign-in/cloudflare-access", {
            method: "POST";
            metadata: {
                SERVER_ONLY: true;
            };
        }, {
            token: string;
        }>;
    };
};

export { CLOUDFLARE_ACCESS_SIGN_IN_PATH, type CloudflareAccessSignInOptions, cloudflareAccessSignIn };
