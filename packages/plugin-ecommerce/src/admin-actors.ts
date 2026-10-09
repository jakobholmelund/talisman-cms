import { inArray } from 'drizzle-orm';
import { user } from 'talisman-cms/auth/local-schema';
import type { TalismanEnv } from 'talisman-cms/client';
import { batchGroups, chunked, commerceDb } from './db';

/** Staff names for display only; audit records retain the original user id. */
export async function adminActorNames(env: TalismanEnv, actorIds: string[]) {
  const db = commerceDb(env);
  const { users } = await batchGroups(db, { users: chunked([...new Set(actorIds)]).map(ids =>
    db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids))) });
  return new Map(users.map(row => [row.id, row.name?.trim() || row.id]));
}
