import {
  user
} from "../chunk-SWN7UFQB.js";
import {
  createDbClient
} from "../chunk-C6NF7RJZ.js";
import "../chunk-7VUPBVR5.js";
import "../chunk-HSF22PCU.js";
import "../chunk-SHMAAJ4S.js";
import "../chunk-WO46ICPJ.js";
import "../chunk-SRVHUFKL.js";
import "../chunk-GAOPNFAO.js";
import "../chunk-MLKGABMK.js";

// src/auth/identity.ts
import { and, eq, sql } from "drizzle-orm";
async function ensureVerifiedEmailIdentity(env, email, name) {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error("Valid verified email required");
  }
  const now = Math.floor(Date.now() / 1e3);
  await env.DB.prepare(`INSERT INTO galaxy_auth_user
    (id, name, email, email_verified, created_at, updated_at, role)
    SELECT ?, ?, ?, 1, ?, ?, 'customer'
    WHERE NOT EXISTS (SELECT 1 FROM galaxy_auth_user WHERE lower(email) = ?)
    ON CONFLICT(email) DO NOTHING`).bind(`shopper_${crypto.randomUUID()}`, name?.trim() || normalized, normalized, now, now, normalized).run();
  const db = createDbClient(env);
  const row = await db.select({ id: user.id }).from(user).where(sql`lower(${user.email}) = ${normalized}`).limit(1).get();
  if (!row?.id) throw new Error("Verified email identity could not be created");
  await db.update(user).set({ emailVerified: true, updatedAt: new Date(now * 1e3) }).where(and(eq(user.id, row.id), eq(user.emailVerified, false)));
  return row.id;
}
export {
  ensureVerifiedEmailIdentity
};
