import { T as TalismanEnv } from '../client-D5mWOXyL.js';
import 'drizzle-orm/d1';
import '../media-Cm407HSH.js';
import 'drizzle-orm/sqlite-core';
import '../actor-BAnSg_qp.js';
import '../types-B9Ys5hZL.js';
import 'astro';

/** Call only after proving control of the email address (for example, a consumed one-time link). */
declare function ensureVerifiedEmailIdentity(env: TalismanEnv, email: string, name?: string | null): Promise<string>;

export { ensureVerifiedEmailIdentity };
