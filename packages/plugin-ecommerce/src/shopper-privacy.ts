import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { TalismanEnv } from 'talisman-cms/client';
import type { BatchItem } from 'drizzle-orm/batch';
import { commitBatch, commerceDb } from './db';
import * as schema from './schema';

const requestSchema = z.object({ accountId: z.string().min(1).max(128), action: z.enum(['export', 'revoke', 'anonymize']),
  reason: z.string().trim().min(8).max(500) }).strict();
export class ShopperPrivacyError extends Error {}

/**
 * Server-side privacy operations, authorized by the caller. The public account route passes only the
 * authenticated account id. Export excludes credentials; anonymization retains accounting ids,
 * items, money, refunds and append-only ledgers. Shared CMS identities remain the core's responsibility.
 */
export async function manageShopperData(env: TalismanEnv, actor: string, input: unknown) {
  const values = requestSchema.parse(input);
  if (!actor.trim()) throw new ShopperPrivacyError('An authenticated actor is required');
  const db = commerceDb(env);
  const account = await db.select().from(schema.customerAccounts).where(eq(schema.customerAccounts.id, values.accountId)).get();
  if (!account || account.anonymizedAt) throw new ShopperPrivacyError('Shopper account is unavailable');
  const now = new Date(); const auditId = `spa_${crypto.randomUUID()}`;
  // Do not destroy contact information while a payment, delivery or monetary entitlement needs it.
  // The same guard is evaluated inside the write batch to cover a checkout racing this request.
  const available = and(eq(schema.customerAccounts.id, account.id), isNull(schema.customerAccounts.anonymizedAt));
  const noObligations = sql`credit_balance = 0
    AND NOT EXISTS(SELECT 1 FROM _ecommerce_recovery_cases c JOIN _ecommerce_orders o ON o.id=c.order_id WHERE o.user_id=${account.id} AND COALESCE((SELECT status FROM _ecommerce_recovery_events WHERE case_id=c.id ORDER BY rowid DESC LIMIT 1),'open')='open')
    AND NOT EXISTS (SELECT 1 FROM _ecommerce_orders o WHERE o.user_id = ${account.id}
      AND (o.status IN ('pending','disputed') OR (o.status IN ('paid','partially_refunded') AND o.fulfillment_status <> 'fulfilled'
        AND (o.shipping_address IS NOT NULL OR EXISTS (SELECT 1 FROM json_each(o.items) i JOIN _ecommerce_products p ON p.id = json_extract(i.value, '$.productId') WHERE p.is_physical = 1)))))
    AND NOT EXISTS (SELECT 1 FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE o.user_id=${account.id} AND COALESCE((SELECT status FROM _ecommerce_return_refund_decisions d WHERE d.receipt_id=r.id ORDER BY rowid DESC LIMIT 1),'review') IN ('review','needed'))
    AND NOT EXISTS (SELECT 1 FROM _ecommerce_return_requests r JOIN _ecommerce_orders o ON o.id=r.order_id WHERE o.user_id=${account.id}
      AND COALESCE((SELECT status FROM _ecommerce_return_request_events e WHERE e.request_id=r.id ORDER BY rowid DESC LIMIT 1),'pending') IN ('pending','approved'))
    AND NOT EXISTS (SELECT 1 FROM _ecommerce_return_receipts r JOIN _ecommerce_orders o ON o.id=r.order_id,json_each(r.items) i WHERE o.user_id=${account.id} AND json_extract(i.value,'$.condition')='inspection'
      AND json_extract(i.value,'$.quantity')>COALESCE((SELECT sum(json_extract(j.value,'$.quantity')) FROM _ecommerce_return_inspections d,json_each(d.items) j WHERE d.receipt_id=r.id AND json_extract(j.value,'$.lineIndex')=json_extract(i.value,'$.lineIndex')),0))
    AND NOT EXISTS (SELECT 1 FROM _ecommerce_referrals r WHERE (r.referrer_account_id = ${account.id} OR r.referred_account_id = ${account.id})
      AND r.status = 'approved' AND NOT EXISTS (SELECT 1 FROM _ecommerce_credit_ledger l WHERE l.order_id = r.order_id
        AND l.account_id = ${account.id} AND l.kind IN ('welcome_award','referral_award')))
    AND NOT EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases p WHERE lower(p.buyer_email) = ${account.emailNormalized}
      AND (p.status IN ('pending','review') OR EXISTS (SELECT 1 FROM _ecommerce_gift_cards c WHERE
        (c.purchase_id = p.id OR c.replaces_purchase_id = p.id) AND c.status <> 'void' AND c.balance_cents > 0)))`;
  const guard = values.action === 'anonymize' ? and(available, noObligations) : available;
  const audit = db.run(sql`INSERT INTO _ecommerce_shopper_audits (id,account_id,action,actor,reason,created_at)
    SELECT ${auditId},id,${values.action},${actor},${values.reason},${Math.floor(now.getTime() / 1000)}
    FROM _ecommerce_customer_accounts WHERE ${guard}`);
  const recorded = sql`EXISTS (SELECT 1 FROM _ecommerce_shopper_audits WHERE id = ${auditId})`;
  if (values.action === 'export') {
    const [orders, credit, referrals, purchases, discounts] = await db.batch([
      db.select().from(schema.orders).where(eq(schema.orders.userId, account.id)),
      db.select().from(schema.creditLedger).where(eq(schema.creditLedger.accountId, account.id)),
      db.select().from(schema.referrals).where(or(eq(schema.referrals.referrerAccountId, account.id), eq(schema.referrals.referredAccountId, account.id))),
      db.select({ id: schema.giftCardPurchases.id, amountCents: schema.giftCardPurchases.amountCents,
        status: schema.giftCardPurchases.status, currency: schema.giftCardPurchases.currency,
        providerRefundedCents: schema.giftCardPurchases.providerRefundedCents, createdAt: schema.giftCardPurchases.createdAt })
        .from(schema.giftCardPurchases).where(eq(sql`lower(${schema.giftCardPurchases.buyerEmail})`, account.emailNormalized)),
      db.select().from(schema.discountRedemptions).where(eq(schema.discountRedemptions.accountId, account.id)),
    ]);
    // Whitelist the document, including a shopper's own data only; referrer/buyer account ids stay private.
    const orderIds = orders.map(order => order.id);
    const details = orderIds.length ? await db.query.orders.findMany({ where: { userId: account.id },
      columns: { id: true }, with: {
        returnRequests: { columns: { id:true,items:true,reason:true,createdAt:true }, with: { reasonCategory: { columns: { code:true } }, events: { columns: { status:true,customerMessage:true,createdAt:true } } } },
        returnReceipts: { columns: { id:true,items:true,createdAt:true }, with: { refundDecisions: { columns: { status:true,amountMinor:true,createdAt:true } } } },
        recoveryCases: { columns: { id:true,kind:true,lineIndex:true,quantity:true,createdAt:true }, with: { shipments: { columns: { quantity:true,carrier:true,trackingNumber:true,createdAt:true } }, events: { columns: { kind:true,status:true,carrier:true,trackingNumber:true,createdAt:true } } } },
        providerRefunds: { columns: { amountCents: true, createdAt: true } },
        giftCardRefunds: { columns: { amountCents: true, createdAt: true } },
        fulfillments: { columns: { kind: true, carrier: true, trackingNumber: true, createdAt: true } },
      } }) : [];
    await audit;
    return { version: 1, exportedAt: now.toISOString(), account: { id: account.id, email: account.email,
      name: account.name, creditBalance: account.creditBalance, createdAt: account.createdAt },
      orders: orders.map(order => ({ id: order.id, status: order.status, fulfillmentStatus: order.fulfillmentStatus,
        items: order.items, totalAmount: order.totalAmount, subtotalAmount: order.subtotalAmount,
        shippingAmount: order.shippingAmount, taxAmount: order.taxAmount, creditApplied: order.creditApplied,
        discountAmount: order.discountAmount, giftCardApplied: order.giftCardApplied, currency: order.currency,
        customerEmail: order.customerEmail, shippingAddress: order.shippingAddress, billingAddress: order.billingAddress,
        providerRefundedCents: order.providerRefundedCents, giftCardRefundedCents: order.giftCardRefundedCents,
        createdAt: order.createdAt, operations: details.find(detail => detail.id === order.id) })),
      credit: credit.map(({ kind, amountCents, orderId, createdAt }) => ({ kind, amountCents, orderId, createdAt })),
      referrals: referrals.map(({ orderId, rewardCents, currency, status, createdAt }) => ({ orderId, rewardCents, currency, status, createdAt })),
      giftCardPurchases: purchases,
      discounts: discounts.map(({ code, orderId, amountCents, status, createdAt }) => ({ code, orderId, amountCents, status, createdAt })),
    };
  }
  const ownedPurchases = db.select({ id: schema.giftCardPurchases.id }).from(schema.giftCardPurchases)
    .where(eq(sql`lower(${schema.giftCardPurchases.buyerEmail})`, account.emailNormalized));
  const statements: BatchItem<'sqlite'>[] = [audit,
    db.update(schema.customerAccounts).set({ sessionVersion: sql`${schema.customerAccounts.sessionVersion} + 1` }).where(and(available, recorded)),
    db.update(schema.customerSessions).set({ revokedAt: now }).where(and(eq(schema.customerSessions.accountId, account.id), recorded)),
    db.update(schema.signInTokens).set({ revokedAt: now }).where(and(eq(schema.signInTokens.emailNormalized, account.emailNormalized), recorded)),
    db.update(schema.carts).set({ sessionToken: null, version: sql`${schema.carts.version} + 1` })
      .where(and(or(eq(schema.carts.userId, account.id), inArray(schema.carts.id,
        db.select({ id: schema.orders.cartId }).from(schema.orders).where(eq(schema.orders.userId, account.id)))), recorded)),
    db.update(schema.orders).set({ guestAccessTokenHash: null, guestBasketTokenHash: null }).where(and(eq(schema.orders.userId, account.id), recorded)),
    db.update(schema.giftCardClaims).set({ revokedAt: now }).where(and(inArray(schema.giftCardClaims.purchaseId, ownedPurchases), recorded)),
    db.update(schema.giftCardPurchases).set({ accessTokenHash: `revoked_${auditId}` }).where(and(inArray(schema.giftCardPurchases.id, ownedPurchases), recorded)),
  ];
  if (values.action === 'anonymize') {
    const anonymousEmail = `${account.id}@anonymized.invalid`;
    statements.push(
      db.update(schema.recoveryCases).set({reason:'[redacted]',redactedAt:now}).where(and(isNull(schema.recoveryCases.redactedAt),inArray(schema.recoveryCases.orderId,db.select({id:schema.orders.id}).from(schema.orders).where(eq(schema.orders.userId,account.id))),recorded)),
      db.update(schema.recoveryEvents).set({reason:'[redacted]',redactedAt:now}).where(and(isNull(schema.recoveryEvents.redactedAt),inArray(schema.recoveryEvents.caseId,db.select({id:schema.recoveryCases.id}).from(schema.recoveryCases).where(inArray(schema.recoveryCases.orderId,db.select({id:schema.orders.id}).from(schema.orders).where(eq(schema.orders.userId,account.id))))),recorded)),
      db.update(schema.recoveryShipments).set({reason:'[redacted]',redactedAt:now}).where(and(isNull(schema.recoveryShipments.redactedAt),inArray(schema.recoveryShipments.caseId,db.select({id:schema.recoveryCases.id}).from(schema.recoveryCases).where(inArray(schema.recoveryCases.orderId,db.select({id:schema.orders.id}).from(schema.orders).where(eq(schema.orders.userId,account.id))))),recorded)),
      db.update(schema.returnRefundDecisions).set({reason:'[redacted]',redactedAt:now}).where(and(isNull(schema.returnRefundDecisions.redactedAt),inArray(schema.returnRefundDecisions.receiptId,db.select({id:schema.returnReceipts.id}).from(schema.returnReceipts).where(inArray(schema.returnReceipts.orderId,db.select({id:schema.orders.id}).from(schema.orders).where(eq(schema.orders.userId,account.id))))),recorded)),
      db.update(schema.returnRequests).set({reason:'[redacted]',redactedAt:now}).where(and(isNull(schema.returnRequests.redactedAt),inArray(schema.returnRequests.orderId,db.select({id:schema.orders.id}).from(schema.orders).where(eq(schema.orders.userId,account.id))),recorded)),
      db.update(schema.returnRequestEvents).set({reason:'[redacted]',customerMessage:'',redactedAt:now}).where(and(isNull(schema.returnRequestEvents.redactedAt),inArray(schema.returnRequestEvents.requestId,db.select({id:schema.returnRequests.id}).from(schema.returnRequests).where(inArray(schema.returnRequests.orderId,db.select({id:schema.orders.id}).from(schema.orders).where(eq(schema.orders.userId,account.id))))),recorded)),
      db.update(schema.orders).set({ customerEmail: null, shippingAddress: null, billingAddress: null })
        .where(and(eq(schema.orders.userId, account.id), recorded)),
      db.update(schema.discountRedemptions).set({ emailNormalized: anonymousEmail }).where(and(eq(schema.discountRedemptions.accountId, account.id), recorded)),
      db.update(schema.giftCardPurchases).set({ buyerEmail: anonymousEmail }).where(and(inArray(schema.giftCardPurchases.id, ownedPurchases), recorded)),
      db.update(schema.customers).set({ email: null, name: null, stripeCustomerId: null }).where(and(or(eq(schema.customers.userId, account.id), eq(sql`lower(${schema.customers.email})`, account.emailNormalized)), recorded)),
      db.update(schema.signInTokens).set({ emailNormalized: anonymousEmail }).where(and(eq(schema.signInTokens.emailNormalized, account.emailNormalized), recorded)),
      db.update(schema.referralCodes).set({ active: false }).where(and(eq(schema.referralCodes.accountId, account.id), recorded)),
      db.update(schema.customerAccounts).set({ email: anonymousEmail, emailNormalized: anonymousEmail, name: null,
        cmsUserId: null, emailVerifiedAt: null, anonymizedAt: now, updatedAt: now }).where(and(available, recorded)),
    );
  }
  await commitBatch(db, statements);
  if (!await db.select({ id: schema.shopperAudits.id }).from(schema.shopperAudits).where(eq(schema.shopperAudits.id, auditId)).get())
    throw new ShopperPrivacyError('Resolve open payments, deliveries, gift cards, open returns and credit awards before anonymizing this shopper');
  return { accountId: account.id, action: values.action, accountingRetained: true };
}
