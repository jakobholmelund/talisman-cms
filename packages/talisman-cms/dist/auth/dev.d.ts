import { T as TalismanAuthAdapter } from '../types-B9Ys5hZL.js';
import 'astro';

/**
 * A mock adapter used strictly for local development.
 * Automatically authenticates any request as a super-admin.
 */
declare function DevAuthAdapter(): TalismanAuthAdapter;

export { DevAuthAdapter };
