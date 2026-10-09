import {
  batchGroups,
  chunked,
  commerceDb
} from "./chunk-S5M56U3H.js";

// src/admin-actors.ts
import { inArray } from "drizzle-orm";
import { user } from "talisman-cms/auth/local-schema";
async function adminActorNames(env, actorIds) {
  const db = commerceDb(env);
  const { users } = await batchGroups(db, { users: chunked([...new Set(actorIds)]).map((ids) => db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids))) });
  return new Map(users.map((row) => [row.id, row.name?.trim() || row.id]));
}

export {
  adminActorNames
};
