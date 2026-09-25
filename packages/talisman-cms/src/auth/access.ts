import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { TalismanAuthAdapter, TalismanUser } from './types';

type AccessEnv = {
  GALAXY_ACCESS_TEAM_DOMAIN?: string;
  GALAXY_ACCESS_AUDIENCE?: string;
  GALAXY_ACCESS_ADMIN_EMAILS?: string;
  GALAXY_ACCESS_EDITOR_EMAILS?: string;
};

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

async function getAccessEnv(): Promise<AccessEnv> {
  try {
    const worker = await import('cloudflare:workers');
    return worker.env as AccessEnv;
  } catch {
    return process.env;
  }
}

/** Verify the Access JWT at the Worker, including its signature, issuer and audience. */
export async function getAccessEmail(request: Request, env: AccessEnv): Promise<string | null | undefined> {
  const teamDomain = env.GALAXY_ACCESS_TEAM_DOMAIN;
  const audience = env.GALAXY_ACCESS_AUDIENCE;
  if (!teamDomain && !audience) return undefined;
  if (!teamDomain || !audience || !/^https:\/\/[^/]+\.cloudflareaccess\.com\/?$/.test(teamDomain)) return null;

  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) return null;

  const issuer = teamDomain.replace(/\/$/, '');
  try {
    let jwks = jwksCache.get(issuer);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
      jwksCache.set(issuer, jwks);
    }
    const { payload } = await jwtVerify(token, jwks, { issuer, audience, algorithms: ['RS256'] });
    return typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

function allowedEmails(value: string | undefined): Set<string> {
  return new Set((value || '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean));
}

/** Authenticate CMS users using a verified Cloudflare Access identity. */
export function AccessAuthAdapter(adminPath = '/admin'): TalismanAuthAdapter {
  const normalizedPath = adminPath === '/' ? '/' : `/${adminPath.replace(/^\/+|\/+$/g, '')}`;
  const adapter: TalismanAuthAdapter = {
    async getUser(request) {
      const env = await getAccessEnv();
      // Access must be configured explicitly. A missing or invalid token never grants a session.
      if (!env.GALAXY_ACCESS_TEAM_DOMAIN || !env.GALAXY_ACCESS_AUDIENCE) return null;
      const email = await getAccessEmail(request, env);
      if (!email) return null;

      const admins = allowedEmails(env.GALAXY_ACCESS_ADMIN_EMAILS);
      const editors = allowedEmails(env.GALAXY_ACCESS_EDITOR_EMAILS);
      const role: TalismanUser['role'] | null = admins.has(email) ? 'admin' : editors.has(email) ? 'editor' : null;
      if (!role) return null;
      return { id: `cloudflare-access:${email}`, email, role };
    },
    async signIn(request) {
      return Response.redirect(new URL(normalizedPath, request.url));
    },
    async signOut(request) {
      return Response.redirect(new URL('/cdn-cgi/access/logout', request.url));
    },
  };

  Object.defineProperty(adapter, '__talismanAuthRuntime', {
    value: {
      moduleId: 'talisman-cms/auth/access',
      exportName: 'AccessAuthAdapter',
      type: 'factory',
      args: [normalizedPath],
    },
    enumerable: false,
  });
  return adapter;
}
