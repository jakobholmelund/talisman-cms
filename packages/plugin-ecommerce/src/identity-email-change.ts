import { and, eq, inArray, sql } from 'drizzle-orm';
import type { IdentityEmailChangeHook } from 'talisman-cms/auth/identity';
import { customerAccounts, customerSessions, signInTokens } from './schema';
import { commerceDb } from './db';

/** Preserve the shopper account id and its orders/credit; revoke shopper sessions and old sign-in links. */
export const identityEmailChange: IdentityEmailChangeHook = async (env, change) => {
  const { userId, oldEmail, newEmail, condition } = change;
  const db = commerceDb(env);
  const now = new Date();
  return [
    db.delete(customerSessions).where(and(inArray(customerSessions.accountId,
      db.select({ id: customerAccounts.id }).from(customerAccounts).where(eq(customerAccounts.cmsUserId, userId))), condition)).getSQL(),
    db.delete(signInTokens).where(and(inArray(signInTokens.emailNormalized, [oldEmail.toLowerCase(), newEmail]), condition)).getSQL(),
    db.update(customerAccounts).set({ email: newEmail, emailNormalized: newEmail, emailVerifiedAt: now,
      updatedAt: now, sessionVersion: sql`${customerAccounts.sessionVersion} + 1` })
      .where(and(eq(customerAccounts.cmsUserId, userId), condition)).getSQL(),
  ];
};
