import type { TalismanEnv } from '../db/client';

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
  const row = await env.DB.prepare(`SELECT id FROM galaxy_auth_user WHERE lower(email) = ? LIMIT 1`)
    .bind(normalized).first<{ id: string }>();
  if (!row?.id) throw new Error('Verified email identity could not be created');
  await env.DB.prepare(`UPDATE galaxy_auth_user SET email_verified = 1, updated_at = ? WHERE id = ? AND email_verified = 0`)
    .bind(now, row.id).run();
  return row.id;
}
