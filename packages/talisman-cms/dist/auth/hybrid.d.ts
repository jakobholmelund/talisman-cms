import { T as TalismanAuthAdapter } from '../types-B9Ys5hZL.js';
import 'astro';

/** Local CMS accounts plus a Cloudflare Access SSO entry point for allowlisted admins. */
declare function HybridAuthAdapter(adminPath?: string): TalismanAuthAdapter;

export { HybridAuthAdapter };
