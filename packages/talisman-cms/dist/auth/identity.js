import {
  user
} from "../chunk-SWN7UFQB.js";
import {
  createDbClient
} from "../chunk-AMX3BXNH.js";
import "../chunk-7VUPBVR5.js";
import "../chunk-HSF22PCU.js";
import "../chunk-SHMAAJ4S.js";
import "../chunk-WO46ICPJ.js";
import "../chunk-GAOPNFAO.js";
import "../chunk-OAGJMNST.js";
import "../chunk-MLKGABMK.js";

// src/auth/identity.ts
import { and, eq, sql } from "drizzle-orm";
async function ensureVerifiedEmailIdentity(env, email, name) {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error("Valid verified email required");
  }
  const now = new Date(Math.floor(Date.now() / 1e3) * 1e3);
  const db = createDbClient(env);
  await db.insert(user).values({
    id: `shopper_${crypto.randomUUID()}`,
    name: name?.trim() || normalized,
    email: normalized,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
    role: "customer"
  }).onConflictDoNothing();
  const row = await db.select({ id: user.id }).from(user).where(sql`lower(${user.email}) = ${normalized}`).limit(1).get();
  if (!row?.id) throw new Error("Verified email identity could not be created");
  await db.update(user).set({ emailVerified: true, updatedAt: now }).where(and(eq(user.id, row.id), eq(user.emailVerified, false)));
  return row.id;
}
export {
  ensureVerifiedEmailIdentity
};
