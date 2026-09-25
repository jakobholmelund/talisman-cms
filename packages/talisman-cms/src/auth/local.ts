import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { admin } from 'better-auth/plugins/admin';
import { hashPassword } from 'better-auth/crypto';
import { drizzle } from 'drizzle-orm/d1';
import { and, eq, count, sql } from 'drizzle-orm';
import type { TalismanAuthAdapter, TalismanUser } from './types';
import type { TalismanEnv } from '../db/client';
import * as schema from './local-schema';
import { getAccessEmail } from './access';

export { getAccessEmail } from './access';

type LocalEnv = TalismanEnv & {
  GALAXY_AUTH_SECRET?: string;
  GALAXY_AUTH_SETUP_TOKEN?: string;
  GALAXY_ACCESS_TEAM_DOMAIN?: string;
  GALAXY_ACCESS_AUDIENCE?: string;
  GALAXY_ACCESS_ADMIN_EMAILS?: string;
};

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
  if (!env.GALAXY_AUTH_SECRET || env.GALAXY_AUTH_SECRET.length < 32) {
    throw new Error('Local CMS authentication requires GALAXY_AUTH_SECRET (at least 32 characters)');
  }

  const origin = new URL(request.url).origin;
  return betterAuth({
    appName: 'Talisman CMS',
    baseURL: origin,
    basePath: `${adminPath === '/' ? '' : adminPath}/api/auth`,
    secret: env.GALAXY_AUTH_SECRET,
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
  const allowed = new Set((env.GALAXY_ACCESS_ADMIN_EMAILS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !allowed.has(email)) {
    return Response.json({ error: 'Cloudflare admin access required' }, { status: 403 });
  }
  const normalizedPath = adminPath === '/' ? '/' : `/${adminPath.replace(/^\/+|\/+$/g, '')}`;
  const auth = createLocalAuth(request, env, normalizedPath);
  const password = await ssoPassword(email, env.GALAXY_AUTH_SECRET!);
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
  const credential = await db.query.account.findFirst({ where: and(eq(schema.account.userId, account.id), eq(schema.account.providerId, 'credential')) });
  const hashed = await hashPassword(password);
  if (credential) {
    await db.update(schema.account).set({ password: hashed, updatedAt: new Date() }).where(eq(schema.account.id, credential.id));
  } else {
    await db.insert(schema.account).values({ id: crypto.randomUUID(), accountId: account.id,
      providerId: 'credential', userId: account.id, password: hashed, createdAt: new Date(), updatedAt: new Date() });
  }
  if (account.role !== 'admin') {
    await db.update(schema.user).set({ role: 'admin', emailVerified: true, updatedAt: new Date() }).where(eq(schema.user.id, account.id));
  }
  await db.delete(schema.session).where(eq(schema.session.userId, account.id));
  const url = new URL(`${normalizedPath === '/' ? '' : normalizedPath}/api/auth/sign-in/email`, request.url);
  const signIn = await auth.handler(new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: new URL(request.url).origin },
    body: JSON.stringify({ email, password }),
  }));
  if (!signIn.ok) return Response.json({ error: 'Cloudflare admin sign-in failed' }, { status: 503 });
  const signedIn = await signIn.clone().json().catch(() => null) as { token?: unknown } | null;
  if (typeof signedIn?.token !== 'string') return Response.json({ error: 'Cloudflare admin session failed' }, { status: 503 });
  await db.update(schema.session).set({ authMethod: 'cloudflare' }).where(eq(schema.session.token, signedIn.token));
  const issuedSession = await db.query.session.findFirst({ where: eq(schema.session.token, signedIn.token) });
  if (issuedSession?.authMethod !== 'cloudflare' || issuedSession.userId !== account.id) {
    return Response.json({ error: 'Cloudflare admin session failed' }, { status: 503 });
  }
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

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  return !origin || origin === new URL(request.url).origin;
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
      if (!rawUser || (rawUser.role !== 'admin' && rawUser.role !== 'editor')) return null;
      if (options.editorOnly && rawUser.role === 'admin') {
        const admins = (env.GALAXY_ACCESS_ADMIN_EMAILS || '').split(',').map(value => value.trim().toLowerCase());
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
        if (options.editorOnly) {
          const body = await request.clone().json().catch(() => null) as { email?: unknown } | null;
          if (typeof body?.email === 'string') {
            const db = drizzle(env.DB, { schema });
            const target = await db.query.user.findFirst({ where: eq(schema.user.email, body.email.trim().toLowerCase()) });
            if (target && target.role !== 'editor') {
              return Response.json({ error: 'This account does not have editor password access' }, { status: 403 });
            }
          }
        }
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
        if (!body || !['admin', 'editor'].includes(String(body.role)) ||
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
          if (existing.role !== 'customer' || existing.banned) {
            return Response.json({ error: 'This email already has a CMS account' }, { status: 409 });
          }
          const auth = createLocalAuth(request, env, normalizedPath);
          if (existing.email !== normalizedEmail) {
            await db.update(schema.user).set({ email: normalizedEmail, updatedAt: new Date() }).where(eq(schema.user.id, existing.id));
          }
          await auth.api.setUserPassword({ body: { userId: existing.id, newPassword: body.password }, headers: request.headers });
          // Better Auth's public type only lists its built-in roles; this installation uses editor/customer too.
          await auth.api.setRole({ body: { userId: existing.id, role: body.role as 'admin' }, headers: request.headers });
          await auth.api.revokeUserSessions({ body: { userId: existing.id }, headers: request.headers });
          return Response.json({ user: { id: existing.id, email: existing.email, role: body.role } },
            { headers: { 'Cache-Control': 'no-store' } });
        }
      }
      const resetBody = action === 'admin/set-user-password'
        ? await request.clone().json().catch(() => null) as { userId?: unknown } | null
        : null;
      if (typeof resetBody?.userId === 'string') {
        const db = drizzle(env.DB, { schema });
        const target = await db.query.user.findFirst({ where: eq(schema.user.id, resetBody.userId) });
        if (target?.role === 'admin' && options.editorOnly) {
          return Response.json({ error: 'Cloudflare SSO accounts are managed through Access' }, { status: 403 });
        }
      }
      if (['admin/set-role', 'admin/ban-user', 'admin/unban-user', 'admin/remove-user'].includes(action)) {
        const body = await request.clone().json().catch(() => null) as { userId?: unknown; role?: unknown } | null;
        if (typeof body?.userId !== 'string' || !body.userId ||
            (action === 'admin/set-role' && (!(options.editorOnly ? ['editor', 'customer'] : ['admin', 'editor']).includes(String(body.role))))) {
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
      }
      const auth = createLocalAuth(request, env, normalizedPath);
      const response = await auth.handler(request);
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'no-store');
      if (action === 'sign-in/email' && response.ok) {
        headers.delete('content-length');
        return Response.json({ ok: true }, { status: response.status, headers });
      }
      if (action === 'admin/set-user-password' && response.ok) {
        if (typeof resetBody?.userId !== 'string') throw new Error('Password reset target missing');
        await auth.api.revokeUserSessions({ body: { userId: resetBody.userId }, headers: request.headers });
      }
      if (action === 'admin/set-role' && response.ok) {
        const body = await request.clone().json() as { userId: string };
        await auth.api.revokeUserSessions({ body: { userId: body.userId }, headers: request.headers });
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
