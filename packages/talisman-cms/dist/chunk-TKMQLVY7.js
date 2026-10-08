import {
  user
} from "./chunk-WHOEA75K.js";
import {
  createDbClient
} from "./chunk-HEG7DNCN.js";

// src/auth/identity.ts
import { and, eq, sql } from "drizzle-orm";
function normalizeIdentityEmail(email) {
  if (typeof email !== "string") return null;
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(normalized) || normalized.startsWith(".") || normalized.includes("..") || normalized.includes(".@") || normalized.split("@")[0].length > 64) {
    return null;
  }
  return normalized;
}
async function ensureVerifiedEmailIdentity(env, email, name) {
  const normalized = normalizeIdentityEmail(email);
  if (!normalized) throw new Error("Valid verified email required");
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
  normalizeIdentityEmail,
  ensureVerifiedEmailIdentity
};
