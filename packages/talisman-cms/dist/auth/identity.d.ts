import { TalismanEnv } from '../client.js';
import 'drizzle-orm/d1';
import '../media-Cfo_aHOS.js';
import 'drizzle-orm/sqlite-core';

/** Call only after proving control of the email address (for example, a consumed one-time link). */
declare function ensureVerifiedEmailIdentity(env: TalismanEnv, email: string, name?: string | null): Promise<string>;

export { ensureVerifiedEmailIdentity };
