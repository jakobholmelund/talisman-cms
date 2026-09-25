import type { TalismanAuthAdapter } from './types';
import { LocalAuthAdapter } from './local';

/** Local CMS accounts plus a Cloudflare Access SSO entry point for allowlisted admins. */
export function HybridAuthAdapter(adminPath = '/admin'): TalismanAuthAdapter {
  const normalizedPath = adminPath === '/' ? '/' : `/${adminPath.replace(/^\/+|\/+$/g, '')}`;
  const adapter = LocalAuthAdapter(normalizedPath, { requireAccess: false, editorOnly: true });
  Object.defineProperty(adapter, '__talismanAuthRuntime', {
    value: {
      moduleId: 'talisman-cms/auth/hybrid',
      exportName: 'HybridAuthAdapter',
      type: 'factory',
      args: [normalizedPath],
    },
    enumerable: false,
    configurable: true,
  });
  return adapter;
}
