import { SQL } from 'drizzle-orm';
import { T as TalismanEnv } from '../client-BnymGq0d.js';
import 'drizzle-orm/d1';
import '../actor-Daa_hmny.js';
import '../types-C5a-hx5D.js';
import 'astro';
import '../query-DgmKqS5C.js';

/** Statements must include `condition`: it proves the confirmation is unconsumed and the identity unchanged. */
type IdentityEmailChangeHook = (env: TalismanEnv, change: {
    userId: string;
    oldEmail: string;
    newEmail: string;
    condition: SQL;
}) => Promise<SQL[]>;
/** The sign-in format shared by staff and verified shopper identities. */
declare function normalizeIdentityEmail(email: unknown): string | null;
/** Call only after proving control of the email address (for example, a consumed one-time link). */
declare function ensureVerifiedEmailIdentity(env: TalismanEnv, email: string, name?: string | null): Promise<string>;

export { type IdentityEmailChangeHook, ensureVerifiedEmailIdentity, normalizeIdentityEmail };
