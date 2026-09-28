import { T as TalismanAuthAdapter } from '../types-C5a-hx5D.js';
import 'astro';

/**
 * Local CMS accounts plus a Cloudflare Access SSO entry point for allowlisted admins. The integration
 * passes its admin path when it loads the adapter in the Worker, so `adminPath` is optional; one that
 * differs from the integration's fails the build.
 */
declare function HybridAuthAdapter(adminPath?: string): TalismanAuthAdapter;

export { HybridAuthAdapter };
