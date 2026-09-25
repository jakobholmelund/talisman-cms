import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { admin } from 'better-auth/plugins/admin';
import { hashPassword } from 'better-auth/crypto';
import { drizzle } from 'drizzle-orm/d1';
import { and, eq, ne, count, sql } from 'drizzle-orm';
import type { TalismanAuthAdapter, TalismanUser } from './types';
import type { TalismanEnv } from '../db/client';
import * as schema from './local-schema';
import { getAccessEmail } from './access';
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
    session: { expiresIn: 60 * 60 * 12, updateAge: 60 * 60 },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    plugins: [admin({ defaultRole: 'editor', adminRoles: ['admin'] })],
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

async function ssoPassword(email: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`talisman-cms-cloudflare-sso:${email}`)));
  const hex = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  return hex;
}

/** Exchange a verified Cloudflare Access admin identity for a local CMS session. */
export async function signInCloudflareAdmin(request: Request, adminPath = '/admin'): Promise<Response> {
  const env = await getLocalAuthEnv();
  const email = await getAccessEmail(request, env);
  const allowed = new Set((readSetting(env, 'ACCESS_ADMIN_EMAILS') || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !allowed.has(email)) {
    return Response.json({ error: 'Cloudflare admin access required' }, { status: 403 });
  }
  const normalizedPath = adminPath === '/' ? '/' : `/${adminPath.replace(/^\/+|\/+$/g, '')}`;
  const auth = createLocalAuth(request, env, normalizedPath);
  const password = await ssoPassword(email, readSetting(env, 'AUTH_SECRET')!);
  const db = drizzle(env.DB, { schema });
  let account = await db.query.user.findFirst({ where: sql`lower(${schema.user.email}) = ${email}` });
  if (!account) {
    try {
      await auth.api.createUser({ body: { email, name: email, password, role: 'admin' } });
    } catch {
      // Another verified sign-in may have created the account concurrently.
    }
    account = await db.query.user.findFirst({ where: sql`lower(${schema.user.email}) = ${email}` });
  }
  if (!account || account.banned) {
    return Response.json({ error: 'Cloudflare admin account is unavailable' }, { status: 403 });
  }
  if (account.email !== email) {
    await db.update(schema.user).set({ email, updatedAt: new Date() }).where(eq(schema.user.id, account.id));
  }
  if (account.role !== 'admin') {
    await db.update(schema.user).set({ role: 'admin', emailVerified: true, updatedAt: new Date() }).where(eq(schema.user.id, account.id));
  }
  // Carry the admin's client IP and user agent onto the session. The direct API call skips the HTTP
  // router's per-IP sign-in rate limit, so other clients' failed attempts cannot block a verified admin.
  const signInHeaders = new Headers({ 'Content-Type': 'application/json' });
  for (const name of ['cf-connecting-ip', 'user-agent']) {
    const value = request.headers.get(name);
    if (value) signInHeaders.set(name, value);
  }
  const signInAdmin = () => auth.api.signInEmail({ body: { email, password }, headers: signInHeaders, asResponse: true });
  let signIn = await signInAdmin();
  if (signIn.status === 401) {
    // The derived credential is missing or stale (for example after a secret rotation); store it and retry once.
    const credential = await db.query.account.findFirst({ where: and(eq(schema.account.userId, account.id), eq(schema.account.providerId, 'credential')) });
    const hashed = await hashPassword(password);
    if (credential) {
      await db.update(schema.account).set({ password: hashed, updatedAt: new Date() }).where(eq(schema.account.id, credential.id));
    } else {
      await db.insert(schema.account).values({ id: crypto.randomUUID(), accountId: account.id,
        providerId: 'credential', userId: account.id, password: hashed, createdAt: new Date(), updatedAt: new Date() });
    }
    signIn = await signInAdmin();
  }
  if (!signIn.ok) return Response.json({ error: 'Cloudflare admin sign-in failed' }, { status: 503 });
  const signedIn = await signIn.clone().json().catch(() => null) as { token?: unknown } | null;
  if (typeof signedIn?.token !== 'string') return Response.json({ error: 'Cloudflare admin session failed' }, { status: 503 });
  await db.update(schema.session).set({ authMethod: 'cloudflare' }).where(eq(schema.session.token, signedIn.token));
  const issuedSession = await db.query.session.findFirst({ where: eq(schema.session.token, signedIn.token) });
  if (issuedSession?.authMethod !== 'cloudflare' || issuedSession.userId !== account.id) {
    return Response.json({ error: 'Cloudflare admin session failed' }, { status: 503 });
  }
  // Revoke the admin's other sessions only once the replacement session exists.
  await db.delete(schema.session).where(and(eq(schema.session.userId, account.id), ne(schema.session.token, signedIn.token)));
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

export function LocalAuthAdapter(adminPath = '/admin', options: { requireAccess?: boolean; editorOnly?: boolean } = {}): TalismanAuthAdapter {
  const normalizedPath = adminPath === '/' ? '/' : `/${adminPath.replace(/^\/+|\/+$/g, '')}`;
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
        const admins = (readSetting(env, 'ACCESS_ADMIN_EMAILS') || '').split(',').map(value => value.trim().toLowerCase());
        if (!admins.includes(rawUser.email.toLowerCase()) || !result?.session?.id) return null;
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
      args: Object.keys(options).length ? [normalizedPath, options] : [normalizedPath],
    },
    enumerable: false,
    configurable: true,
  });
  return adapter;
}
