import type { TalismanAuthAdapter, TalismanUser } from './types';

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

/**
 * Vite replaces `import.meta.env.DEV` with `true` under `astro dev` and with `false` in every build,
 * so a DevAuthAdapter that reaches a deployed Worker never signs anyone in. Outside Vite it is unset.
 */
function isViteDevServer(): boolean {
  try {
    return (import.meta as ImportMeta & { env: { DEV?: unknown } }).env.DEV === true;
  } catch {
    return false;
  }
}

/**
 * A mock adapter for `astro dev` on a loopback address only. It signs every request in as an admin.
 * The integration refuses it for `astro build` and for a dev server exposed with `--host`, and it
 * authenticates nothing outside the Vite dev server, whatever the request's Host header says.
 */
export function DevAuthAdapter(): TalismanAuthAdapter {
  const adapter: TalismanAuthAdapter = {
    async getUser(req) {
      if (!isViteDevServer()) return null;
      const hostname = new URL(req.url).hostname;
      if (!LOOPBACK_HOSTS.includes(hostname)) {
        return null;
      }
      return {
        id: 'dev-user-001',
        email: 'admin@talisman-cms.local',
        name: 'Local Developer',
        role: 'admin'
      } satisfies TalismanUser;
    },
    async signIn() {
      // In a real adapter, we'd initiate OAuth or magic rings
      return new Response('Sign In Not Implemented for Dev Adapter', { status: 501 });
    },
    async signOut() {
      return new Response('Sign Out Not Implemented for Dev Adapter', { status: 501 });
    }
  };

  Object.defineProperty(adapter, '__talismanAuthRuntime', {
    value: {
      moduleId: 'talisman-cms/auth/dev',
      exportName: 'DevAuthAdapter',
      type: 'factory'
    },
    enumerable: false
  });

  return adapter;
}
