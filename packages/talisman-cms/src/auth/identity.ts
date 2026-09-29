import { and, eq, sql } from 'drizzle-orm';
import { createDbClient, type TalismanEnv } from '../db/client';
import { user } from './local-schema';

/** Call only after proving control of the email address (for example, a consumed one-time link). */
export async function ensureVerifiedEmailIdentity(env: TalismanEnv, email: string, name?: string | null): Promise<string> {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error('Valid verified email required');
  }
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
