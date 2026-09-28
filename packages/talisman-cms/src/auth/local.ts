import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { admin } from 'better-auth/plugins/admin';
import { drizzle } from 'drizzle-orm/d1';
import { and, eq, count, sql } from 'drizzle-orm';
import type { TalismanAuthAdapter, TalismanUser } from './types';
import type { TalismanEnv } from '../db/client';
import * as schema from './local-schema';
import { getAccessEmail } from './access';
import { cloudflareAccessSignIn } from './cloudflare-access';
import { readSetting } from '../env';

export { getAccessEmail } from './access';

type LocalEnv = TalismanEnv & {
  TALISMAN_AUTH_SECRET?: string;
  TALISMAN_AUTH_SETUP_TOKEN?: string;
  TALISMAN_ACCESS_TEAM_DOMAIN?: string;
  TALISMAN_ACCESS_AUDIENCE?: string;
  TALISMAN_ACCESS_ADMIN_EMAILS?: string;
};

/** Sessions slide with use (12 hours idle), but none outlives this age; the user must sign in again. */
const MAX_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function getLocalAuthEnv(): Promise<LocalEnv> {
  try {
    const worker = await import('cloudflare:workers');
    return worker.env as unknown as LocalEnv;
  } catch {
    return process.env as unknown as LocalEnv;
  }
}

function createLocalAuth(request: Request, env: LocalEnv, adminPath = '/admin') {
  if (!env.DB) throw new Error('Local CMS authentication requires the DB binding');
  const secret = readSetting(env, 'AUTH_SECRET');
  if (!secret || secret.length < 32) {
    throw new Error('Local CMS authentication requires TALISMAN_AUTH_SECRET (at least 32 characters)');
  }

  const origin = new URL(request.url).origin;
  return betterAuth({
    appName: 'Talisman CMS',
    baseURL: origin,
    basePath: `${adminPath === '/' ? '' : adminPath}/api/auth`,
    secret,
    trustedOrigins: [origin],
    database: drizzleAdapter(drizzle(env.DB, { schema }), {
      provider: 'sqlite',
      schema,
    }),
    session: {
      expiresIn: 60 * 60 * 12,
      updateAge: 60 * 60,
      // How the session was issued: `cloudflare` for an Access sign-in. Set at creation, never by a client.
      additionalFields: { authMethod: { type: 'string', required: false, input: false } },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    plugins: [
      // A user created without a role is a shopper: the table holds shopper identities too, and only an
      // explicit admin or editor role grants CMS access.
      admin({ defaultRole: 'customer', adminRoles: ['admin'] }),
      cloudflareAccessSignIn({
        verify: (headers) => getAccessEmail(new Request(origin, { headers }), env),
        allowed: () => allowlistedAdmins(env),
        maxSessionAgeMs: MAX_SESSION_AGE_MS,
      }),
    ],
    rateLimit: {
      enabled: true,
      storage: 'database',
      customRules: {
        '/sign-in/email': { window: 15 * 60, max: 10 },
      },
    },
    advanced: {
      cookiePrefix: 'talisman-cms',
      useSecureCookies: new URL(request.url).protocol === 'https:',
      // Cloudflare sets CF-Connecting-IP itself; X-Forwarded-For is client-controlled there,
      // and an unresolvable IP would put every sign-in into one shared rate-limit bucket.
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    },
  });
}

/** The lower-cased emails of TALISMAN_ACCESS_ADMIN_EMAILS. */
function allowlistedAdmins(env: LocalEnv): Set<string> {
  return new Set((readSetting(env, 'ACCESS_ADMIN_EMAILS') || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
}

/**
 * Exchange a verified Cloudflare Access admin identity for a CMS session. The session is minted by the
 * `cloudflareAccessSignIn` endpoint, which verifies the Access JWT from the forwarded headers itself,
 * so no password is involved and the auth secret signs cookies and nothing else. Only the JWT, the
 * client IP and the user agent are forwarded: the endpoint takes no body.
 */
export async function signInCloudflareAdmin(request: Request, adminPath = '/admin'): Promise<Response> {
  const env = await getLocalAuthEnv();
  // Refuse an unverified caller before anything else is set up; the endpoint verifies the token again.
  const email = await getAccessEmail(request, env);
  if (!email || !allowlistedAdmins(env).has(email)) {
    return Response.json({ error: 'Cloudflare admin access required' }, { status: 403 });
  }
  const normalizedPath = adminPath === '/' ? '/' : `/${adminPath.replace(/^\/+|\/+$/g, '')}`;
  const auth = createLocalAuth(request, env, normalizedPath);
  const forwarded = new Headers();
  for (const name of ['cf-access-jwt-assertion', 'cf-connecting-ip', 'user-agent']) {
    const value = request.headers.get(name);
    if (value) forwarded.set(name, value);
  }
  let signIn: Response;
  try {
    signIn = await auth.api.signInCloudflareAccess({ headers: forwarded, asResponse: true });
  } catch (error) {
    console.error('[talisman-cms] Cloudflare admin sign-in failed', error);
    return Response.json({ error: 'Cloudflare admin sign-in failed' }, { status: 503 });
  }
  if (signIn.status === 403) {
    const body = await signIn.json().catch(() => null) as { message?: unknown } | null;
    return Response.json({ error: typeof body?.message === 'string' ? body.message : 'Cloudflare admin access required' }, { status: 403 });
  }
  if (!signIn.ok) return Response.json({ error: 'Cloudflare admin sign-in failed' }, { status: 503 });
  const headers = new Headers({ Location: normalizedPath, 'Cache-Control': 'no-store' });
  for (const cookie of signIn.headers.getSetCookie()) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}

export async function createInitialAdmin(
  request: Request,
  env: LocalEnv,
  adminPath: string,
  details: { email: string; name: string; password: string },
): Promise<void> {
  const auth = createLocalAuth(request, env, adminPath);
  await auth.api.createUser({ body: { ...details, role: 'admin' } });
}

/** Better Auth's wrong-password response, so accounts without CMS password access look like unknown emails. */
function invalidCredentials(): Response {
  return Response.json({ message: 'Invalid email or password', code: 'INVALID_EMAIL_OR_PASSWORD' },
    { status: 401, statusText: 'UNAUTHORIZED', headers: { 'Cache-Control': 'no-store' } });
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  return !origin || origin === new URL(request.url).origin;
}

const SESSIONS_NOT_ENDED = 'The change was saved, but existing sessions for this account could not be ended. Repeat the action to end them.';
const DISABLED_SESSIONS_NOT_ENDED = 'The account was disabled, but its existing sessions could not be ended. They cannot open the CMS while the account is disabled, and they are ended before it is enabled again.';
const REVOKED_SESSIONS_NOT_ENDED = 'CMS access was revoked, but existing sessions for this account could not be ended. They cannot open the CMS without CMS access, and they are ended before access is granted again.';
const GRANT_NOT_SAVED = 'Existing sessions for this account could not be ended, so nothing was changed. Try again.';

/**
 * End a user's sessions after an account change has been saved. A failure is returned as a warning,
 * since reporting an error would hide the committed change. getUser re-reads the role and ban on every
 * request, so leftover sessions lose CMS access at once after a role change or ban, but not after a password reset.
 */
async function revokeSessionsAfterChange(auth: ReturnType<typeof createLocalAuth>, userId: string, headers: Headers,
  warning = SESSIONS_NOT_ENDED): Promise<string | undefined> {
  try {
    await auth.api.revokeUserSessions({ body: { userId }, headers });
    return undefined;
  } catch (error) {
    console.error('[talisman-cms] Could not end CMS sessions after an account change', error);
    return warning;
  }
}

/**
 * End a user's sessions before enabling the account or granting it a CMS role. Sessions left behind by a
 * failed revocation would otherwise regain CMS access with the grant, so a failure here changes nothing.
 */
async function endSessionsBeforeGrant(auth: ReturnType<typeof createLocalAuth>, userId: string, headers: Headers): Promise<Response | undefined> {
  try {
    await auth.api.revokeUserSessions({ body: { userId }, headers });
    return undefined;
  } catch (error) {
    console.error('[talisman-cms] Could not end CMS sessions before restoring CMS access', error);
    return Response.json({ error: GRANT_NOT_SAVED }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}

/**
 * Local CMS accounts on D1. The integration passes its admin path when it loads the adapter in the
 * Worker, so `adminPath` is optional; one that differs from the integration's fails the build.
 */
export function LocalAuthAdapter(adminPath?: string, options: { requireAccess?: boolean; editorOnly?: boolean } = {}): TalismanAuthAdapter {
  const normalizedPath = normalizeAuthAdminPath(adminPath);
  const adapter: TalismanAuthAdapter = {
    async getUser(request) {
      const env = await getLocalAuthEnv();
      const accessEmail = options.requireAccess === false ? undefined : await getAccessEmail(request, env);
      if (accessEmail === null) return null;

      const auth = createLocalAuth(request, env, normalizedPath);
      const result = await auth.api.getSession({ headers: request.headers });
      const rawUser = result?.user;
      if (!result || !rawUser) return null;
      // Better Auth keeps extending a session in use, so cap its total age here, where every CMS request is checked.
      if (!(Date.now() - new Date(result.session.createdAt).getTime() <= MAX_SESSION_AGE_MS)) {
        await drizzle(env.DB, { schema }).delete(schema.session).where(eq(schema.session.id, result.session.id));
        return null;
      }
      // Better Auth only checks bans when a session is created; a disabled account's other sessions end here.
      if (rawUser.banned && !(rawUser.banExpires && new Date(rawUser.banExpires).getTime() < Date.now())) return null;
      if (rawUser.role !== 'admin' && rawUser.role !== 'editor') return null;
      if (options.editorOnly && rawUser.role === 'admin') {
        if (!allowlistedAdmins(env).has(rawUser.email.toLowerCase()) || !result?.session?.id) return null;
        const cmsSession = await drizzle(env.DB, { schema }).query.session.findFirst({ where: eq(schema.session.id, result.session.id) });
        if (cmsSession?.authMethod !== 'cloudflare') return null;
      }
      if (accessEmail !== undefined && accessEmail !== rawUser.email.toLowerCase()) return null;
      return {
        id: rawUser.id,
        email: rawUser.email,
        name: rawUser.name,
        avatarUrl: rawUser.image ?? undefined,
        role: rawUser.role,
      } satisfies TalismanUser;
    },
    async signIn(request) {
      return Response.redirect(new URL(normalizedPath, request.url));
    },
    async signOut(request) {
      const url = new URL(`${normalizedPath === '/' ? '' : normalizedPath}/api/auth/sign-out`, request.url);
      const headers = new Headers(request.headers);
      headers.set('Content-Type', 'application/json');
      return adapter.handle!(new Request(url, { method: 'POST', headers, body: '{}' }));
    },
    async handle(request) {
      if (!sameOrigin(request)) return Response.json({ error: 'Cross-origin auth request rejected' }, { status: 403 });
      const env = await getLocalAuthEnv();
      const accessEmail = options.requireAccess === false ? undefined : await getAccessEmail(request, env);
      if (accessEmail === null) return Response.json({ error: 'Cloudflare Access authorization required' }, { status: 403 });

      const basePath = `${normalizedPath === '/' ? '' : normalizedPath}/api/auth/`;
      const path = new URL(request.url).pathname;
      if (!path.startsWith(basePath)) return new Response(null, { status: 404 });
      const action = path.slice(basePath.length);
      const allowedActions = new Set([
        'sign-in/email', 'sign-out', 'change-password',
        'admin/list-users', 'admin/create-user', 'admin/set-user-password',
        'admin/set-role', 'admin/ban-user', 'admin/unban-user', 'admin/remove-user',
      ]);
      if (!allowedActions.has(action)) {
        return new Response(null, { status: 404 });
      }
      if (options.editorOnly && action === 'change-password') {
        const current = await adapter.getUser(request);
        if (current?.role === 'admin') return Response.json({ error: 'Admin sign-in is managed through Cloudflare' }, { status: 403 });
      }
      if (action === 'sign-in/email') {
        if (request.method !== 'POST') return new Response(null, { status: 405 });
        // Account roles are checked only after Better Auth has rate-limited the request and verified the
        // password, so the response never reveals whether an email belongs to a shopper or an admin.
        if (accessEmail !== undefined) {
          const body = await request.clone().json().catch(() => null) as { email?: unknown } | null;
          if (typeof body?.email !== 'string' || body.email.toLowerCase() !== accessEmail) {
            return Response.json({ error: 'Account must match Cloudflare Access identity' }, { status: 403 });
          }
        }
      } else {
        const user = await adapter.getUser(request);
        if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
        if (action.startsWith('admin/') && user.role !== 'admin') {
          return Response.json({ error: 'Admin access required' }, { status: 403 });
        }
      }
      if (action === 'admin/create-user') {
        const body = await request.clone().json().catch(() => null) as { role?: unknown; password?: unknown; email?: unknown } | null;
        if (!body || typeof body.role !== 'string' || !['admin', 'editor'].includes(body.role) ||
            (options.editorOnly && body.role !== 'editor') ||
            typeof body.password !== 'string' || body.password.length < 12 ||
            typeof body.email !== 'string') {
          return Response.json({ error: 'Choose an admin or editor role and a password of at least 12 characters' }, { status: 400 });
        }
        if (typeof body.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) {
          return Response.json({ error: 'Valid email required' }, { status: 400 });
        }
        const db = drizzle(env.DB, { schema });
        const normalizedEmail = body.email.trim().toLowerCase();
        const existing = await db.query.user.findFirst({ where: sql`lower(${schema.user.email}) = ${normalizedEmail}` });
        if (existing) {
          if (existing.role !== 'customer') {
            return Response.json({ error: 'This email already has a CMS account' }, { status: 409 });
          }
          if (existing.banned) {
            // A disabled account keeps its ban after losing CMS access; re-enabling it is a separate, explicit step.
            return Response.json({ error: 'This account is disabled. Enable it in the user list before granting CMS access.' }, { status: 409 });
          }
          const auth = createLocalAuth(request, env, normalizedPath);
          const notGranted = await endSessionsBeforeGrant(auth, existing.id, request.headers);
          if (notGranted) return notGranted;
          if (existing.email !== normalizedEmail) {
            await db.update(schema.user).set({ email: normalizedEmail, updatedAt: new Date() }).where(eq(schema.user.id, existing.id));
          }
          await auth.api.setUserPassword({ body: { userId: existing.id, newPassword: body.password }, headers: request.headers });
          // Better Auth's public type only lists its built-in roles; this installation uses editor/customer too.
          await auth.api.setRole({ body: { userId: existing.id, role: body.role as 'admin' }, headers: request.headers });
          return Response.json({ user: { id: existing.id, email: existing.email, role: body.role } },
            { headers: { 'Cache-Control': 'no-store' } });
        }
      }
      // Better Auth's handler consumes the request body, so the validated target is kept here for the
      // session revocation that follows a password or role change.
      let revokeUserId: string | undefined;
      let revokeWarning = SESSIONS_NOT_ENDED;
      let banUserId: string | undefined;
      const resetBody = action === 'admin/set-user-password'
        ? await request.clone().json().catch(() => null) as { userId?: unknown } | null
        : null;
      if (action === 'admin/set-user-password') {
        // Better Auth coerces userId to a string, so reject arrays and other shapes before the guards below.
        if (typeof resetBody?.userId !== 'string' || !resetBody.userId) {
          return Response.json({ error: 'Choose a valid user' }, { status: 400 });
        }
        revokeUserId = resetBody.userId;
        const db = drizzle(env.DB, { schema });
        const target = await db.query.user.findFirst({ where: eq(schema.user.id, resetBody.userId) });
        if (target?.role === 'admin' && options.editorOnly) {
          return Response.json({ error: 'Cloudflare SSO accounts are managed through Access' }, { status: 403 });
        }
      }
      if (['admin/set-role', 'admin/ban-user', 'admin/unban-user', 'admin/remove-user'].includes(action)) {
        const body = await request.clone().json().catch(() => null) as { userId?: unknown; role?: unknown } | null;
        if (typeof body?.userId !== 'string' || !body.userId ||
            (action === 'admin/set-role' && (typeof body.role !== 'string' ||
              !(options.editorOnly ? ['editor', 'customer'] : ['admin', 'editor']).includes(body.role)))) {
          return Response.json({ error: 'Choose a valid user and role' }, { status: 400 });
        }
        const actor = await adapter.getUser(request);
        if (!actor || actor.role !== 'admin') return Response.json({ error: 'Admin access required' }, { status: 403 });
        if (body.userId === actor.id) {
          return Response.json({ error: 'You cannot change your own access here' }, { status: 400 });
        }
        const db = drizzle(env.DB, { schema });
        const target = await db.query.user.findFirst({ where: eq(schema.user.id, body.userId) });
        if (target?.role === 'admin' && options.editorOnly) {
          return Response.json({ error: 'Cloudflare SSO accounts are managed through Access' }, { status: 403 });
        }
        if (options.editorOnly && action === 'admin/set-role' && target?.role === 'customer' && body.role === 'editor') {
          return Response.json({ error: 'Grant editor access by setting a password in Add editor' }, { status: 400 });
        }
        if (options.editorOnly && action === 'admin/remove-user') {
          return Response.json({ error: 'Use Revoke CMS access to retain the shared shopper identity' }, { status: 400 });
        }
        if (target?.role === 'admin' && !target.banned &&
            (action === 'admin/ban-user' || action === 'admin/remove-user' ||
              (action === 'admin/set-role' && body.role !== 'admin'))) {
          const [{ total }] = await db.select({ total: count() }).from(schema.user)
            .where(and(eq(schema.user.role, 'admin'), eq(schema.user.banned, false)));
          if (total <= 1) {
            return Response.json({ error: 'At least one active admin account is required' }, { status: 400 });
          }
        }
        const grantsAccess = target && ((action === 'admin/unban-user' && target.banned) ||
          (action === 'admin/set-role' && !['admin', 'editor'].includes(target.role ?? '') && body.role !== 'customer'));
        if (grantsAccess) {
          const notGranted = await endSessionsBeforeGrant(createLocalAuth(request, env, normalizedPath), body.userId, request.headers);
          if (notGranted) return notGranted;
        }
        if (action === 'admin/set-role') {
          revokeUserId = body.userId;
          if (body.role === 'customer') revokeWarning = REVOKED_SESSIONS_NOT_ENDED;
        }
        if (action === 'admin/ban-user') banUserId = body.userId;
      }
      const auth = createLocalAuth(request, env, normalizedPath);
      const response = await auth.handler(request);
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'no-store');
      if (action === 'sign-in/email' && response.status >= 400 && response.status < 500 && response.status !== 429) {
        // Better Auth rejects a disabled account only after checking its password (403 BANNED_USER), which
        // would confirm the password. Every refusal but the rate limit, which keeps its X-Retry-After, looks
        // like a wrong password.
        return invalidCredentials();
      }
      if (action === 'sign-in/email' && response.ok) {
        const signedIn = await response.clone().json().catch(() => null) as { token?: unknown } | null;
        const db = drizzle(env.DB, { schema });
        const [issued] = typeof signedIn?.token === 'string'
          ? await db.select({ role: schema.user.role }).from(schema.session)
            .innerJoin(schema.user, eq(schema.user.id, schema.session.userId))
            .where(eq(schema.session.token, signedIn.token)).limit(1)
          : [];
        if (!issued || !(options.editorOnly ? ['editor'] : ['admin', 'editor']).includes(issued.role)) {
          // Admins use Cloudflare SSO in editor-only mode and shoppers never get CMS sessions: drop the session
          // and answer exactly like a wrong password.
          if (typeof signedIn?.token === 'string') await db.delete(schema.session).where(eq(schema.session.token, signedIn.token));
          return invalidCredentials();
        }
        headers.delete('content-length');
        return Response.json({ ok: true }, { status: response.status, headers });
      }
      if (revokeUserId && response.ok) {
        const warning = await revokeSessionsAfterChange(auth, revokeUserId, request.headers, revokeWarning);
        if (warning) {
          const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
          headers.delete('content-length');
          return Response.json({ ...payload, warning }, { status: response.status, headers });
        }
      }
      if (banUserId && response.status >= 500) {
        // Better Auth saves the ban before deleting the user's sessions. If only the deletion failed, the ban
        // is in force (getUser rejects banned users), so report it as saved rather than as an error.
        const target = await drizzle(env.DB, { schema }).query.user.findFirst({ where: eq(schema.user.id, banUserId) });
        if (target?.banned) {
          console.error('[talisman-cms] Could not end CMS sessions after disabling an account');
          headers.delete('content-length');
          headers.set('Content-Type', 'application/json');
          return Response.json({ user: target, warning: DISABLED_SESSIONS_NOT_ENDED }, { status: 200, headers });
        }
      }
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    },
  };

  Object.defineProperty(adapter, '__talismanAuthRuntime', {
    value: {
      moduleId: 'talisman-cms/auth/local',
      exportName: 'LocalAuthAdapter',
      type: 'factory',
      args: Object.keys(options).length ? [options] : [],
      adminPath: true,
      ...(adminPath === undefined ? {} : { configuredAdminPath: normalizedPath }),
    },
    enumerable: false,
    configurable: true,
  });
  return adapter;
}

/** `/admin` when unset, `/` for a root admin, otherwise a leading slash and no trailing one. */
export function normalizeAuthAdminPath(adminPath?: string): string {
  const trimmed = adminPath?.trim();
  if (!trimmed) return '/admin';
  if (trimmed === '/') return '/';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
}
