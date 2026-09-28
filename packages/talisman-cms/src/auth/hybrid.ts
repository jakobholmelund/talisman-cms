import type { TalismanAuthAdapter } from './types';
import { LocalAuthAdapter, normalizeAuthAdminPath } from './local';

/**
 * Local CMS accounts plus a Cloudflare Access SSO entry point for allowlisted admins. The integration
 * passes its admin path when it loads the adapter in the Worker, so `adminPath` is optional; one that
 * differs from the integration's fails the build.
 */
export function HybridAuthAdapter(adminPath?: string): TalismanAuthAdapter {
  const normalizedPath = normalizeAuthAdminPath(adminPath);
  const adapter = LocalAuthAdapter(normalizedPath, { requireAccess: false, editorOnly: true });
  Object.defineProperty(adapter, '__talismanAuthRuntime', {
    value: {
      moduleId: 'talisman-cms/auth/hybrid',
      exportName: 'HybridAuthAdapter',
      type: 'factory',
      args: [],
      adminPath: true,
      ...(adminPath === undefined ? {} : { configuredAdminPath: normalizedPath }),
    },
    enumerable: false,
    configurable: true,
  });
  return adapter;
}
