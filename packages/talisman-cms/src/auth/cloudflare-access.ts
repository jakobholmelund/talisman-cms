import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import type { BetterAuthPlugin } from 'better-auth';

/** The endpoint's path inside better-auth. It is never in the auth proxy's allowlist, so HTTP cannot reach it. */
export const CLOUDFLARE_ACCESS_SIGN_IN_PATH = '/sign-in/cloudflare-access';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface CloudflareAccessSignInOptions {
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
export function cloudflareAccessSignIn(options: CloudflareAccessSignInOptions) {
  return {
    id: 'talisman-cloudflare-access',
    endpoints: {
      signInCloudflareAccess: createAuthEndpoint(CLOUDFLARE_ACCESS_SIGN_IN_PATH, { method: 'POST', metadata: { SERVER_ONLY: true } }, async (ctx) => {
        const headers = ctx.headers ?? new Headers();
        const email = await options.verify(headers);
        if (!email || !EMAIL.test(email) || !options.allowed().has(email)) {
          throw new APIError('FORBIDDEN', { message: 'Cloudflare admin access required' });
        }
        const adapter = ctx.context.internalAdapter;
        let found = await adapter.findUserByEmail(email);
        if (!found) {
          try {
            await adapter.createUser({ email, name: email, emailVerified: true, role: 'admin' }, { method: 'sso-oidc' });
          } catch {
            // Another verified sign-in may have created the row concurrently; the lookup below decides.
          }
          found = await adapter.findUserByEmail(email);
        }
        if (!found) throw new APIError('SERVICE_UNAVAILABLE', { message: 'Cloudflare admin account could not be created' });
        let user = found.user as typeof found.user & { role?: string | null; banned?: boolean | null; banExpires?: Date | null };
        if (user.banned && !(user.banExpires && new Date(user.banExpires).getTime() < Date.now())) {
          throw new APIError('FORBIDDEN', { message: 'Cloudflare admin account is unavailable' });
        }
        // The allowlist is the authority on who is an admin; the row follows it, and keeps its exact email.
        if (user.role !== 'admin' || !user.emailVerified || user.email !== email) {
          user = await adapter.updateUser(user.id, { role: 'admin', emailVerified: true, email });
        }
        for (const account of await adapter.findAccounts(user.id)) {
          if (account.providerId === 'credential') await adapter.deleteAccount(account.id);
        }
        const now = Date.now();
        const stale = (await adapter.listSessions(user.id)).filter((session) =>
          new Date(session.expiresAt).getTime() <= now || now - new Date(session.createdAt).getTime() > options.maxSessionAgeMs);
        if (stale.length) await adapter.deleteSessions(stale.map((session) => session.token));
        const session = await adapter.createSession(user.id, false, {
          authMethod: 'cloudflare',
          ipAddress: headers.get('cf-connecting-ip') || undefined,
          userAgent: headers.get('user-agent') || undefined,
        });
        if (!session) throw new APIError('SERVICE_UNAVAILABLE', { message: 'Cloudflare admin session failed' });
        await setSessionCookie(ctx, { session, user });
        return ctx.json({ token: session.token });
      }),
    },
  } satisfies BetterAuthPlugin;
}
