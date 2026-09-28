import { and, eq, sql } from 'drizzle-orm';
import { createDbClient, type TalismanEnv } from '../db/client';
import { user } from './local-schema';

/** Call only after proving control of the email address (for example, a consumed one-time link). */
export async function ensureVerifiedEmailIdentity(env: TalismanEnv, email: string, name?: string | null): Promise<string> {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error('Valid verified email required');
  }
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`INSERT INTO galaxy_auth_user
    (id, name, email, email_verified, created_at, updated_at, role)
    SELECT ?, ?, ?, 1, ?, ?, 'customer'
    WHERE NOT EXISTS (SELECT 1 FROM galaxy_auth_user WHERE lower(email) = ?)
    ON CONFLICT(email) DO NOTHING`)
    .bind(`shopper_${crypto.randomUUID()}`, name?.trim() || normalized, normalized, now, now, normalized).run();
  const db = createDbClient(env);
  const row = await db.select({ id: user.id }).from(user).where(sql`lower(${user.email}) = ${normalized}`).limit(1).get();
  if (!row?.id) throw new Error('Verified email identity could not be created');
  await db.update(user).set({ emailVerified: true, updatedAt: new Date(now * 1000) })
    .where(and(eq(user.id, row.id), eq(user.emailVerified, false)));
  return row.id;
}
