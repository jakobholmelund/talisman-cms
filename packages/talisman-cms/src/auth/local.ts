import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { admin } from 'better-auth/plugins/admin';
import { drizzle } from 'drizzle-orm/d1';
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

export function LocalAuthAdapter(adminPath = '/admin'): TalismanAuthAdapter {
  const normalizedPath = adminPath === '/' ? '/' : `/${adminPath.replace(/^\/+|\/+$/g, '')}`;
  const adapter: TalismanAuthAdapter = {
    async getUser(request) {
      const env = await getLocalAuthEnv();
      const accessEmail = await getAccessEmail(request, env);
      if (accessEmail === null) return null;

      const auth = createLocalAuth(request, env, normalizedPath);
      const result = await auth.api.getSession({ headers: request.headers });
      const rawUser = result?.user;
      if (!rawUser || (rawUser.role !== 'admin' && rawUser.role !== 'editor')) return null;
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
      const accessEmail = await getAccessEmail(request, env);
      if (accessEmail === null) return Response.json({ error: 'Cloudflare Access authorization required' }, { status: 403 });

      const basePath = `${normalizedPath === '/' ? '' : normalizedPath}/api/auth/`;
      const path = new URL(request.url).pathname;
      if (!path.startsWith(basePath)) return new Response(null, { status: 404 });
      const action = path.slice(basePath.length);
      const allowedActions = new Set([
        'sign-in/email', 'sign-out', 'change-password',
        'admin/list-users', 'admin/create-user', 'admin/set-user-password',
      ]);
      if (!allowedActions.has(action)) {
        return new Response(null, { status: 404 });
      }
      if (action === 'sign-in/email') {
        if (request.method !== 'POST') return new Response(null, { status: 405 });
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
        const body = await request.clone().json().catch(() => null) as { role?: unknown; password?: unknown } | null;
        if (!body || !['admin', 'editor'].includes(String(body.role)) ||
            typeof body.password !== 'string' || body.password.length < 12) {
          return Response.json({ error: 'Choose an admin or editor role and a password of at least 12 characters' }, { status: 400 });
        }
      }
      const resetBody = action === 'admin/set-user-password'
        ? await request.clone().json().catch(() => null) as { userId?: unknown } | null
        : null;
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
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    },
  };

  Object.defineProperty(adapter, '__talismanAuthRuntime', {
    value: {
      moduleId: 'talisman-cms/auth/local',
      exportName: 'LocalAuthAdapter',
      type: 'factory',
      args: [normalizedPath],
    },
    enumerable: false,
  });
  return adapter;
}
