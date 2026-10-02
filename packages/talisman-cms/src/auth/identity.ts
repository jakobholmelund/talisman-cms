import { and, eq, sql, type SQL } from 'drizzle-orm';
import { createDbClient, type TalismanEnv } from '../db/client';
import { user } from './local-schema';

/** Statements must include `condition`: it proves the confirmation is unconsumed and the identity unchanged. */
export type IdentityEmailChangeHook = (env: TalismanEnv, change: {
  userId: string; oldEmail: string; newEmail: string; condition: SQL;
}) => Promise<SQL[]>;

/** The sign-in format shared by staff and verified shopper identities. */
export function normalizeIdentityEmail(email: unknown): string | null {
  if (typeof email !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(normalized) || normalized.startsWith('.') || normalized.includes('..') || normalized.includes('.@') || normalized.split('@')[0].length > 64) {
    return null;
  }
  return normalized;
}

/** Call only after proving control of the email address (for example, a consumed one-time link). */
export async function ensureVerifiedEmailIdentity(env: TalismanEnv, email: string, name?: string | null): Promise<string> {
  const normalized = normalizeIdentityEmail(email);
  if (!normalized) throw new Error('Valid verified email required');
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const db = createDbClient(env);
  // A user with this address in any letter case already exists: the unique index on lower(email)
  // refuses the row, and the existing user is used.
  await db.insert(user).values({ id: `shopper_${crypto.randomUUID()}`, name: name?.trim() || normalized, email: normalized,
    emailVerified: true, createdAt: now, updatedAt: now, role: 'customer' }).onConflictDoNothing();
  const row = await db.select({ id: user.id }).from(user).where(sql`lower(${user.email}) = ${normalized}`).limit(1).get();
  if (!row?.id) throw new Error('Verified email identity could not be created');
  await db.update(user).set({ emailVerified: true, updatedAt: now })
    .where(and(eq(user.id, row.id), eq(user.emailVerified, false)));
  return row.id;
}
