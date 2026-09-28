import { T as TalismanEnv } from '../client-Ccx_f4Il.js';
import 'drizzle-orm/d1';
import 'drizzle-orm';
import '../actor-Daa_hmny.js';
import '../types-C5a-hx5D.js';
import 'astro';

/** Call only after proving control of the email address (for example, a consumed one-time link). */
declare function ensureVerifiedEmailIdentity(env: TalismanEnv, email: string, name?: string | null): Promise<string>;

export { ensureVerifiedEmailIdentity };
