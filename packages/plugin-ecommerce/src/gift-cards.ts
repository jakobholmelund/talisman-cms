import { and, count, eq, exists, gt, inArray, isNull, lt, ne, not, or, sql, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { alias, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import type { TalismanEnv } from 'talisman-cms/client';
import { commerceDb, commitBatch, type CommerceDb } from './db';
import { readSetting } from 'talisman-cms/env';
import { creditLedger, discountRedemptions, giftCardClaims, giftCardOrderRefunds, giftCardPurchases, giftCardRedemptions,
  giftCardRefunds, giftCards, orders, payments } from './schema';
import type { PaymentProviderAdapter } from './payments';
import { getReferralPolicy, referralReversalStatements } from './referrals';
import { readStoreSettings } from './store-settings';
import { minimumChargeAmount } from './money';
import { WebhookMismatchError } from './webhook-errors';
import { ReconcileFailure, assertStoreStripeMode, sessionLookupFailure } from './reconcile';
import { giftCardClaimEmail, type GiftCardClaimEmail } from './emails';
import { applyEmailTemplate, bareEmailAddress, commerceEmailHeld, commerceEmailSetup, commerceEmailStatement,
  emailErrorCode, holdCommerceEmail, missingEmailSettings, releaseCommerceEmailStatement, sendCommerceEmailNow,
  sendCommerceMessage, supersedeCommerceEmailStatement, type CommerceEmailComposer,
  type CommerceEmailSetup } from './email-deliveries';

const MIN_CARD_CENTS = 500;
const amountSchema = z.number().int().min(MIN_CARD_CENTS).max(100_000);
const purchaseIdSchema = z.string().regex(/^gp_[0-9a-f-]{36}$/);
const purchaseSchema = z.object({
  amountCents: amountSchema,
  buyerEmail: z.string().trim().email().max(254),
}).strict();
const adminIssueSchema = z.object({
  amountCents: amountSchema,
  reason: z.string().trim().min(8).max(500),
  // A card support issues in place of a purchased one takes over the value left on the purchase's card.
  replacesPurchaseId: purchaseIdSchema.optional(),
}).strict();

const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const unhex = (value: string) => new Uint8Array(value.match(/.{2}/g)?.map(byte => parseInt(byte, 16)) ?? []);
const randomHex = (bytes: number) => hex(crypto.getRandomValues(new Uint8Array(bytes)));
const utf8 = new TextEncoder();
/** A time in Unix seconds as the schema's timestamp columns take it. */
const at = (seconds: number) => new Date(seconds * 1000);

// Codes are stored as `v2:<key id>:<iv>:<ciphertext>`: AES-GCM under TALISMAN_COMMERCE_GIFT_CARD_KEY with
// the card id as additional data, so a ciphertext copied to another card does not decrypt. The key id is
// derived from the key, so rotation needs no id setting. Codes stored before key ids were recorded are
// `<iv>:<ciphertext>` without additional data, and are tried with every configured key.
const KEY_PATTERN = /^[0-9a-fA-F]{64}$/;
const VERSIONED_SECRET = /^v2:([0-9a-f]{16}):([0-9a-f]{24}):((?:[0-9a-f]{2}){17,})$/;
const UNVERSIONED_SECRET = /^([0-9a-fA-F]{24}):((?:[0-9a-fA-F]{2}){17,})$/;

type GiftCardKey = { id: string; key: CryptoKey };
type StoredCardSecret = { id: string; codeHash: string; encryptedCode: string };

async function importGiftCardKey(value: string): Promise<GiftCardKey> {
  const raw = unhex(value);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  return { id: hex(digest).slice(0, 16),
    key: await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']) };
}

/** The key new codes are encrypted with. */
async function currentGiftCardKey(env: TalismanEnv) {
  const value = readSetting(env, 'COMMERCE_GIFT_CARD_KEY');
  if (!value || !KEY_PATTERN.test(value)) throw new Error('Gift card encryption key is not configured');
  return importGiftCardKey(value);
}

/** The current key, then the previous keys that still decrypt codes stored before a rotation. */
async function giftCardKeyring(env: TalismanEnv) {
  const keys = [await currentGiftCardKey(env)];
  const previous = (readSetting(env, 'COMMERCE_GIFT_CARD_PREVIOUS_KEYS') ?? '')
    .split(',').map(value => value.trim()).filter(Boolean);
  if (previous.some(value => !KEY_PATTERN.test(value))) {
    throw new Error('Each previous gift card key must be 64 hex characters');
  }
  for (const value of previous) {
    const key = await importGiftCardKey(value);
    if (!keys.some(known => known.id === key.id)) keys.push(key);
  }
  return keys;
}

export async function hashGiftCardSecret(value: string) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

async function encryptCardSecret(key: GiftCardKey, cardId: string, code: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(cardId) },
    key.key, utf8.encode(code));
  return `v2:${key.id}:${hex(iv)}:${hex(new Uint8Array(ciphertext))}`;
}

async function openCardSecret(key: GiftCardKey, iv: string, ciphertext: string, cardId?: string) {
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(iv),
      ...(cardId === undefined ? {} : { additionalData: utf8.encode(cardId) }) }, key.key, unhex(ciphertext)));
  } catch {
    return null;
  }
}

async function decryptCardSecret(keys: GiftCardKey[], card: StoredCardSecret) {
  let code: string | null = null;
  const versioned = VERSIONED_SECRET.exec(card.encryptedCode);
  if (versioned) {
    const key = keys.find(known => known.id === versioned[1]);
    if (!key) throw new Error(`Gift card code uses key ${versioned[1]}, which is not configured`);
    code = await openCardSecret(key, versioned[2], versioned[3], card.id);
  } else {
    const unversioned = UNVERSIONED_SECRET.exec(card.encryptedCode);
    if (!unversioned) throw new Error('Gift card secret is invalid');
    for (const key of keys) {
      code = await openCardSecret(key, unversioned[1], unversioned[2]);
      if (code !== null) break;
    }
  }
  // An unversioned ciphertext carries no card id, so the stored hash is what ties it to this card.
  if (code === null || await hashGiftCardSecret(code) !== card.codeHash) {
    throw new Error('Gift card code cannot be decrypted with the configured keys');
  }
  return code;
}

async function newCardSecret(env: TalismanEnv, cardId: string) {
  const code = `GIFT-${randomHex(16).toUpperCase()}`;
  return { code, codeHash: await hashGiftCardSecret(code), codeSuffix: code.slice(-4),
    encryptedCode: await encryptCardSecret(await currentGiftCardKey(env), cardId, code) };
}

const reencryptSchema = z.object({
  after: z.string().max(100).optional(),
  // Each update is a D1 query, and a Worker invocation on the Free plan may run only 50.
  limit: z.number().int().min(1).max(40).optional(),
}).strict();

/**
 * Re-encrypts, with the current key, codes stored under a previous key or before key ids were
 * recorded, one page of up to `limit` cards per call. Pass the returned `next` as `after` until it is
 * null; when a fresh run finds nothing left, the previous keys can be removed. A code that no
 * configured key decrypts is listed in `failed` and left as it is. A Worker from a release before key
 * ids cannot show a code once it is re-encrypted.
 */
export async function reencryptGiftCardCodes(env: TalismanEnv, input: unknown = {}) {
  const { after = '', limit = 25 } = reencryptSchema.parse(input ?? {});
  const keys = await giftCardKeyring(env);
  const current = keys[0];
  const prefix = `v2:${current.id}:`;
  const db = commerceDb(env);
  const rows = await db.select({ id: giftCards.id, codeHash: giftCards.codeHash, encryptedCode: giftCards.encryptedCode })
    .from(giftCards)
    .where(and(sql`substr(${giftCards.encryptedCode}, 1, ${prefix.length}) <> ${prefix}`, gt(giftCards.id, after)))
    .orderBy(giftCards.id).limit(limit);
  // Only while the stored ciphertext is still the one decrypted here.
  const reencrypt = (row: typeof rows[number], encryptedCode: string) => db.update(giftCards).set({ encryptedCode })
    .where(and(eq(giftCards.id, row.id), eq(giftCards.encryptedCode, row.encryptedCode))).returning({ id: giftCards.id });
  type Reencrypt = ReturnType<typeof reencrypt>;
  const statements: Reencrypt[] = [];
  const failed: string[] = [];
  for (const row of rows) {
    try {
      const code = await decryptCardSecret(keys, row);
      statements.push(reencrypt(row, await encryptCardSecret(current, row.id, code)));
    } catch {
      failed.push(row.id);
    }
  }
  const results = statements.length ? await db.batch(statements as [Reencrypt, ...Reencrypt[]]) : [];
  return { keyId: current.id, reencrypted: results.reduce((sum, updated) => sum + updated.length, 0),
    failed, next: rows.length === limit ? rows[rows.length - 1].id : null };
}

/**
 * The current key's id; how many stored codes carry the id of another key; and how many are in the
 * format of releases before key ids, which the current key or a previous one reads. Null without a key.
 */
export async function getGiftCardKeyStatus(env: TalismanEnv) {
  let current: GiftCardKey;
  try {
    current = await currentGiftCardKey(env);
  } catch {
    return null;
  }
  const prefix = `v2:${current.id}:`;
  const row = await commerceDb(env).select({
    previousKeyCodes: sql<number>`COALESCE(SUM(substr(${giftCards.encryptedCode},1,3) = 'v2:'
      AND substr(${giftCards.encryptedCode},1,${prefix.length}) <> ${prefix}),0)`,
    legacyCodes: sql<number>`COALESCE(SUM(substr(${giftCards.encryptedCode},1,3) <> 'v2:'),0)`,
  }).from(giftCards).get();
  return { keyId: current.id, previousKeyCodes: row?.previousKeyCodes ?? 0, legacyCodes: row?.legacyCodes ?? 0 };
}

// The purchase and card rows as the statements below alias them, so the fragments name their columns
// through the schema; in a sql template with `FROM _ecommerce_gift_card_purchases p` they render as "p".
const p = alias(giftCardPurchases, 'p');
const c = alias(giftCards, 'c');
/**
 * The purchase row's id for a subquery in a select's fields, as text: in a select from one table the
 * builder writes every column object in its fields unqualified, so `p.id` would become `"id"` and name
 * the subquery's own table. In a `where` and in a sql template the column object renders as "p"."id".
 */
const P_ID = sql.raw('p.id');
/** A purchase row: the aliased one, or the table in a statement that names it directly. */
type PurchaseRow = typeof p | typeof giftCardPurchases;
/** A reference to a purchase's id: a row's id column, the text `P_ID`, or a bound id. */
type PurchaseRef = AnySQLiteColumn | SQL;
// Paid, or refunded with nothing left to decide: not held for review, and every refund taken off its cards.
const settledPurchase = (purchase: PurchaseRow) => sql`(${purchase.status} = 'paid' OR (${purchase.status} IN ('partially_refunded','refunded')
  AND ${purchase.refundAdjustedCents} = ${purchase.providerRefundedCents}))`;
// The cards a purchase funds are its purchased card and the replacements that took over its value. The
// one that holds the value now is the card that is not void, newest replacement first: each replacement
// voids the cards it replaces, so there is normally only one.
const currentCard = (purchase: PurchaseRef) => sql`(SELECT k.id FROM _ecommerce_gift_cards k
  WHERE (k.purchase_id = ${purchase} OR k.replaces_purchase_id = ${purchase}) AND k.status <> 'void'
  ORDER BY k.source = 'admin' DESC,k.created_at DESC,k.id DESC LIMIT 1)`;
// A checkout in progress holds value on one of the purchase's cards. Its release would credit that card,
// so the card must not be voided before the checkout completes or expires.
const pendingCheckout = (purchase: PurchaseRef) => sql`EXISTS (SELECT 1 FROM _ecommerce_gift_card_redemptions r
  JOIN _ecommerce_gift_cards f ON f.id = r.card_id
  WHERE (f.purchase_id = ${purchase} OR f.replaces_purchase_id = ${purchase}) AND r.status = 'reserved')`;
const cardValue = (purchase: PurchaseRef) => sql<number>`(SELECT COALESCE(SUM(f.balance_cents),0) FROM _ecommerce_gift_cards f
  WHERE (f.purchase_id = ${purchase} OR f.replaces_purchase_id = ${purchase}) AND f.status <> 'void')`;

const units = (cents: number, currency: string) => `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;

/** Explains why a purchase's card cannot be replaced by a card of this amount. */
async function assertReplaceable(db: CommerceDb, purchaseId: string, amountCents: number) {
  const purchase = await db.select({ status: p.status, currency: p.currency, settled: settledPurchase(p),
    value: cardValue(P_ID), pending: pendingCheckout(P_ID) }).from(p).where(eq(p.id, purchaseId)).get();
  if (!purchase?.settled || !['paid', 'partially_refunded'].includes(purchase.status)) {
    throw new Error('Only the card of a paid purchase that is not held for review can be replaced');
  }
  if (purchase.pending) {
    throw new Error('A checkout in progress holds value on this purchase\'s card; replace it once that checkout completes or expires');
  }
  if (purchase.value < MIN_CARD_CENTS) {
    throw new Error(`Only ${units(purchase.value, purchase.currency)} is left on the purchase's card, too little for a replacement`);
  }
  if (purchase.value !== amountCents) {
    throw new Error(`A replacement carries exactly what is left on the purchase's card: ${units(purchase.value, purchase.currency)}`);
  }
}

/**
 * Migration 0015 keeps gift cards and their purchases in USD only, so a store that sells in another
 * currency cannot issue, sell or redeem them. At checkout this is a refusal of the entered code like
 * any other, so shoppers get the one message.
 */
function giftCardCurrency(env: TalismanEnv) {
  const { currency } = readStoreSettings(env);
  if (currency !== 'usd') throw new GiftCardRefusal('currency', 'Gift cards are available only in stores that use USD');
  return currency;
}

export async function issueAdminGiftCard(env: TalismanEnv, actor: string, input: unknown) {
  const currency = giftCardCurrency(env);
  const { amountCents, reason, replacesPurchaseId } = adminIssueSchema.parse(input);
  if (!actor.trim()) throw new Error('Administrator identity is required');
  const replaces = replacesPurchaseId ?? null;
  const db = commerceDb(env);
  if (replaces) await assertReplaceable(db, replaces, amountCents);
  const id = `gift_${crypto.randomUUID()}`;
  const secret = await newCardSecret(env, id);
  const timestamp = Math.floor(Date.now() / 1000);
  // A replacement takes over exactly the value left on the purchase's cards, which are emptied and voided
  // in the same batch, so the purchase never funds two spendable cards and the lost code stops working.
  const replacementIssued = sql`EXISTS (SELECT 1 FROM _ecommerce_gift_cards n WHERE n.id = ${id})`;
  const [inserted] = await db.batch([
    db.all<{ id: string }>(sql`INSERT INTO _ecommerce_gift_cards
      (id,code_hash,code_suffix,encrypted_code,source,admin_actor,admin_reason,replaces_purchase_id,initial_cents,balance_cents,currency,status,created_at,updated_at)
      SELECT ${id},${secret.codeHash},${secret.codeSuffix},${secret.encryptedCode},'admin',${actor},${reason},${replaces},${amountCents},0,${currency},'active',${timestamp},${timestamp}
      WHERE ${replaces} IS NULL OR EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases p
        WHERE p.id = ${replaces} AND p.currency = ${currency} AND p.status IN ('paid','partially_refunded') AND ${settledPurchase(p)}
          AND NOT ${pendingCheckout(p.id)} AND ${cardValue(p.id)} = ${amountCents})
      RETURNING id`),
    db.run(sql`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,purchase_id,kind,amount_cents,created_at)
      SELECT ${`gcl_issue_${id}`},id,replaces_purchase_id,'issue',initial_cents,${timestamp} FROM _ecommerce_gift_cards WHERE id = ${id}`),
    ...(replaces ? [
      db.run(sql`INSERT INTO _ecommerce_gift_card_ledger
        (id,card_id,purchase_id,kind,amount_cents,created_at)
        SELECT 'gcl_replaced_' || c.id,c.id,${replaces},'purchase_reversal',-c.balance_cents,${timestamp}
        FROM _ecommerce_gift_cards c WHERE (c.purchase_id = ${replaces} OR c.replaces_purchase_id = ${replaces}) AND c.id <> ${id}
          AND c.status <> 'void' AND c.balance_cents > 0 AND ${replacementIssued}`),
      db.update(giftCards).set({ status: 'void', heldForReview: false, updatedAt: at(timestamp) })
        .where(and(or(eq(giftCards.purchaseId, replaces), eq(giftCards.replacesPurchaseId, replaces)), ne(giftCards.id, id),
          ne(giftCards.status, 'void'), replacementIssued)),
    ] : []),
  ]);
  if (!inserted.length) throw new Error('The purchase changed while its card was being replaced; reload and try again');
  return { id, code: secret.code, amountCents, currency, replacesPurchaseId: replaces };
}

const isoSeconds = (seconds: unknown) => typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null;

/** The newest claim link of a card, as the admin list shows it. */
function claimLinkView(value: unknown) {
  if (typeof value !== 'string') return null;
  const link = JSON.parse(value) as Record<string, unknown>;
  return { createdAt: isoSeconds(link.createdAt), expiresAt: isoSeconds(link.expiresAt), usedAt: isoSeconds(link.usedAt),
    revokedAt: isoSeconds(link.revokedAt), resent: link.resent === 1 };
}

/** The claim email sent after a purchase: its status and, while it is not sent, the last error code. */
function claimEmailView(value: unknown) {
  if (typeof value !== 'string') return null;
  const email = JSON.parse(value) as { status: string; lastError: string | null; attempts: number };
  return { status: email.status, lastError: email.lastError, attempts: email.attempts };
}

export async function getGiftCardsAdmin(env: TalismanEnv) {
  const db = commerceDb(env);
  return db.select({ id: giftCards.id, codeSuffix: giftCards.codeSuffix,
    source: giftCards.source, purchaseId: giftCards.purchaseId, replacesPurchaseId: giftCards.replacesPurchaseId,
    // The buyer of the purchase the card belongs to or replaces; the claim link resend goes there. The
    // subqueries name the card's columns with their table, because drizzle leaves them unqualified.
    buyerEmail: sql<string | null>`(SELECT p.buyer_email FROM _ecommerce_gift_card_purchases p
      WHERE p.id = COALESCE(_ecommerce_gift_cards.purchase_id, _ecommerce_gift_cards.replaces_purchase_id))`,
    adminActor: giftCards.adminActor, adminReason: giftCards.adminReason, initialCents: giftCards.initialCents,
    balanceCents: giftCards.balanceCents, currency: giftCards.currency, status: giftCards.status,
    // While its purchase is held for review, the card cannot be reactivated.
    inReview: sql<boolean>`EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases p
      WHERE p.id IN (${giftCards.purchaseId}, ${giftCards.replacesPurchaseId}) AND p.status = 'review')`.mapWith(Boolean),
    // Read through the purchase index: a card's links all belong to its purchase, or to the one it replaces.
    claimLink: sql`(SELECT json_object('createdAt', l.created_at, 'expiresAt', l.expires_at, 'usedAt', l.used_at,
        'revokedAt', l.revoked_at, 'resent', l.created_by IS NOT NULL)
      FROM _ecommerce_gift_card_claims l
      WHERE l.purchase_id = COALESCE(_ecommerce_gift_cards.purchase_id, _ecommerce_gift_cards.replaces_purchase_id)
        AND l.card_id = _ecommerce_gift_cards.id
      -- A link the buyer can still use comes first, so a resend that failed never hides a working link.
      ORDER BY (l.used_at IS NULL AND l.revoked_at IS NULL AND l.expires_at > CAST(strftime('%s', 'now') AS INTEGER)) DESC,
        l.created_at DESC, l.rowid DESC LIMIT 1)`.mapWith(claimLinkView),
    claimEmail: sql`(SELECT json_object('status', d.status, 'lastError', d.last_error, 'attempts', d.attempts)
      FROM _ecommerce_email_deliveries d WHERE d.kind = 'gift_card_claim' AND d.subject_id = _ecommerce_gift_cards.purchase_id)`
      .mapWith(claimEmailView),
    createdAt: giftCards.createdAt }).from(giftCards)
    .orderBy(giftCards.createdAt);
}

// A purchase as the review screen shows it: its refunds, the card that holds its value, what was spent
// from its cards on orders (checkouts in progress included), and what checkouts in progress hold.
const reviewQuery = (db: CommerceDb) => db.select({
  purchaseId: p.id, status: p.status, amountCents: p.amountCents, currency: p.currency,
  refundedCents: p.providerRefundedCents, adjustedCents: p.refundAdjustedCents,
  cardId: c.id, codeSuffix: c.codeSuffix, cardStatus: c.status, cardHeld: c.heldForReview,
  cardReplacement: sql<boolean>`${c.replacesPurchaseId} IS NOT NULL`.mapWith(Boolean), balanceCents: c.balanceCents,
  spentCents: sql<number>`(SELECT -COALESCE(SUM(l.amount_cents),0) FROM _ecommerce_gift_card_ledger l
    JOIN _ecommerce_gift_cards f ON f.id = l.card_id
    WHERE (f.purchase_id = ${P_ID} OR f.replaces_purchase_id = ${P_ID})
      AND l.kind IN ('reserve','release','refund_restore'))`,
  pendingCents: sql<number>`(SELECT COALESCE(SUM(r.amount_cents),0) FROM _ecommerce_gift_card_redemptions r
    JOIN _ecommerce_gift_cards f ON f.id = r.card_id
    WHERE (f.purchase_id = ${P_ID} OR f.replaces_purchase_id = ${P_ID}) AND r.status = 'reserved')`,
  replacementCount: sql<number>`(SELECT COUNT(*) FROM _ecommerce_gift_cards f WHERE f.replaces_purchase_id = ${P_ID})`,
}).from(p).leftJoin(c, eq(c.id, currentCard(p.id)));
type ReviewRow = Awaited<ReturnType<typeof reviewQuery>>[number];
/** A purchase without a card left has no hold to show. */
const reviewView = (row: ReviewRow) => ({ ...row, cardHeld: row.cardHeld === true });

// A purchase under an open payment dispute is held until the dispute closes, not by a decision.
const openDispute = (purchase: PurchaseRef) => sql<number>`EXISTS (SELECT 1 FROM _ecommerce_disputes d
  WHERE d.gift_card_purchase_id = ${purchase} AND d.closed_at IS NULL)`;

/**
 * Purchases held for review after a provider refund, oldest first, with what is left on their cards.
 * Purchases held by an open payment dispute wait for its outcome and are left out.
 */
export async function getGiftCardReviewsAdmin(env: TalismanEnv) {
  const db = commerceDb(env);
  const held = and(eq(p.status, 'review'), not(openDispute(p.id)));
  // Read apart: D1 returns a batch's rows keyed by column name, so a joined select loses its second `id`.
  const rows = await reviewQuery(db).where(held).orderBy(p.updatedAt, p.id).limit(100);
  const total = await db.select({ count: count() }).from(p).where(held).get();
  return { reviews: rows.map(reviewView), reviewCount: total?.count ?? 0 };
}

export async function setGiftCardActive(env: TalismanEnv, id: string, active: boolean) {
  if (!/^gift_[0-9a-f-]{36}$/.test(id) || typeof active !== 'boolean') throw new Error('Invalid gift card');
  const db = commerceDb(env);
  const card = await db.select().from(giftCards).where(eq(giftCards.id, id)).get();
  if (!card || card.status === 'void') throw new Error('Gift card is unavailable');
  // Suspending is always possible. A purchased card, or a replacement for one, is reactivated only once
  // its purchase is paid or its refund is resolved. Either choice replaces a review hold, so reinstating
  // the purchase later leaves the card as the administrator set it.
  const timestamp = Math.floor(Date.now() / 1000);
  const settled = (purchaseId: AnySQLiteColumn) => exists(db.select({ one: sql`1` }).from(giftCardPurchases)
    .where(and(eq(giftCardPurchases.id, purchaseId), settledPurchase(giftCardPurchases))));
  const reactivatable = and(or(isNull(giftCards.purchaseId), settled(giftCards.purchaseId)),
    or(isNull(giftCards.replacesPurchaseId), settled(giftCards.replacesPurchaseId)));
  const result = await db.update(giftCards).set({ status: active ? 'active' : 'suspended', heldForReview: false, updatedAt: at(timestamp) })
    .where(and(eq(giftCards.id, id), ne(giftCards.status, 'void'), active ? reactivatable : undefined))
    .returning({ id: giftCards.id });
  if (!result.length) throw new Error('Gift card purchase requires review');
  return { id, status: active ? 'active' : 'suspended' };
}

/** Why a gift card was refused. The reason is for server-side use; shoppers see one message. */
export type GiftCardRefusalReason = 'format' | 'unavailable' | 'nothing_due' | 'cannot_cover' | 'currency';

/**
 * A gift card refused for this order, or in a store whose currency gift cards do not support.
 * `message` is the detailed reason for admin tools and logs.
 */
export class GiftCardRefusal extends Error {
  readonly reason: GiftCardRefusalReason;
  constructor(reason: GiftCardRefusalReason, message: string) {
    super(message);
    this.name = 'GiftCardRefusal';
    this.reason = reason;
  }
}

/** Checks a gift card against the amount still due and returns what it pays, or throws a GiftCardRefusal. */
export async function evaluateGiftCard(env: TalismanEnv, code: string, amountDue: number) {
  const currency = giftCardCurrency(env);
  const normalized = code.trim().toUpperCase();
  if (!/^GIFT-[A-F0-9]{32}$/.test(normalized)) throw new GiftCardRefusal('format', 'Invalid gift card code');
  const db = commerceDb(env);
  const card = await db.select().from(giftCards)
    .where(eq(giftCards.codeHash, await hashGiftCardSecret(normalized))).get();
  if (!card || card.status !== 'active' || card.currency !== currency || card.balanceCents <= 0) {
    throw new GiftCardRefusal('unavailable', 'Gift card is unavailable');
  }
  if (!Number.isSafeInteger(amountDue) || amountDue <= 0) throw new GiftCardRefusal('nothing_due', 'No balance remains to pay');
  const amount = card.balanceCents >= amountDue ? amountDue
    : Math.min(card.balanceCents, Math.max(0, amountDue - minimumChargeAmount(currency)));
  if (amount <= 0) throw new GiftCardRefusal('cannot_cover', 'Gift card cannot cover this order or a valid split payment');
  return { id: card.id, codeSuffix: card.codeSuffix, amount, remainingCents: card.balanceCents };
}

export async function getGiftCardBalance(env: TalismanEnv, code: string) {
  const normalized = code.trim().toUpperCase();
  if (!/^GIFT-[A-F0-9]{32}$/.test(normalized)) throw new Error('Invalid gift card code');
  const db = commerceDb(env);
  const card = await db.select({ balanceCents: giftCards.balanceCents,
    currency: giftCards.currency, status: giftCards.status }).from(giftCards)
    .where(eq(giftCards.codeHash, await hashGiftCardSecret(normalized))).get();
  if (!card) throw new Error('Gift card not found');
  return card;
}

export async function startGiftCardPurchase(env: TalismanEnv, adapter: PaymentProviderAdapter,
  input: unknown, urls: { successUrl: string; cancelUrl: string }) {
  if (adapter.providerId !== 'stripe') throw new Error('Gift card purchases require Stripe');
  const currency = giftCardCurrency(env);
  // Refuse before payment when the code could not be issued or shown afterwards.
  await giftCardKeyring(env);
  const values = purchaseSchema.parse(input);
  const id = `gp_${crypto.randomUUID()}`;
  const accessToken = randomHex(32);
  const timestamp = Math.floor(Date.now() / 1000);
  const db = commerceDb(env);
  const pending = and(eq(giftCardPurchases.id, id), eq(giftCardPurchases.status, 'pending'));
  await db.insert(giftCardPurchases).values({ id, buyerEmail: values.buyerEmail, amountCents: values.amountCents,
    currency, status: 'pending', accessTokenHash: await hashGiftCardSecret(accessToken),
    createdAt: at(timestamp), updatedAt: at(timestamp) });
  let providerSessionId: string | undefined;
  try {
    const session = await adapter.createCheckoutSession({ orderId: id, currency,
      items: [{ name: 'Talisman digital gift card', priceCents: values.amountCents, quantity: 1 }],
      customerEmail: values.buyerEmail,
      metadata: { giftCardPurchaseId: id },
      successUrl: urls.successUrl.replace('{PURCHASE_ID}', id), cancelUrl: urls.cancelUrl });
    providerSessionId = session.providerSessionId;
    await db.update(giftCardPurchases).set({ providerSessionId: session.providerSessionId, updatedAt: at(timestamp) })
      .where(pending);
    return { id, accessToken, paymentUrl: session.url };
  } catch (error) {
    if (providerSessionId) {
      try { await adapter.expireCheckoutSession?.(providerSessionId); }
      catch {
        await db.update(giftCardPurchases).set({ providerSessionId }).where(pending);
        throw error;
      }
    }
    await db.update(giftCardPurchases).set({ status: 'cancelled', updatedAt: new Date() }).where(pending);
    throw error;
  }
}

export async function confirmGiftCardPurchase(env: TalismanEnv, session: {
  id: string; metadata?: { giftCardPurchaseId?: string }; client_reference_id?: string;
  amount_total?: number; currency?: string; payment_status?: string; payment_intent?: string;
}) {
  const id = session.metadata?.giftCardPurchaseId;
  if (!id) throw new Error('Gift card purchase ID is missing');
  const db = commerceDb(env);
  const purchase = await db.select().from(giftCardPurchases).where(eq(giftCardPurchases.id, id)).get();
  if (!purchase || purchase.providerSessionId !== session.id ||
    purchase.amountCents !== session.amount_total ||
    session.currency?.toLowerCase() !== purchase.currency.toLowerCase() ||
    session.payment_status !== 'paid' || typeof session.payment_intent !== 'string') {
    throw new WebhookMismatchError('purchase_mismatch', 'Gift card payment does not match purchase');
  }
  if (purchase.status === 'paid') return { success: true, purchaseId: id, duplicate: true };
  // A payment recorded before and refunded or held for review since.
  if (['partially_refunded', 'refunded', 'review'].includes(purchase.status)
    && purchase.paymentIntentId === session.payment_intent) return { success: true, purchaseId: id, duplicate: true };
  if (purchase.status !== 'pending') {
    throw new WebhookMismatchError('purchase_not_pending', 'Gift card purchase is no longer pending');
  }
  const cardId = `gift_${crypto.randomUUID()}`;
  const secret = await newCardSecret(env, cardId);
  const timestamp = Math.floor(Date.now() / 1000);
  await commitBatch(db, [
    db.update(giftCardPurchases).set({ status: 'paid', paymentIntentId: session.payment_intent, updatedAt: at(timestamp) })
      .where(and(eq(giftCardPurchases.id, id), eq(giftCardPurchases.status, 'pending'), eq(giftCardPurchases.providerSessionId, session.id))),
    db.run(sql`INSERT INTO _ecommerce_gift_cards
      (id,code_hash,code_suffix,encrypted_code,source,purchase_id,initial_cents,balance_cents,currency,status,created_at,updated_at)
      SELECT ${cardId},${secret.codeHash},${secret.codeSuffix},${secret.encryptedCode},'purchase',id,amount_cents,0,currency,'active',${timestamp},${timestamp}
      FROM _ecommerce_gift_card_purchases WHERE id = ${id} AND status = 'paid'
      ON CONFLICT(purchase_id) DO NOTHING`),
    db.run(sql`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,purchase_id,kind,amount_cents,created_at)
      SELECT 'gcl_issue_' || id,id,purchase_id,'issue',initial_cents,${timestamp}
      FROM _ecommerce_gift_cards WHERE purchase_id = ${id} ON CONFLICT(id) DO NOTHING`),
    // The buyer gets a claim link once, however often the payment is confirmed.
    db.run(commerceEmailStatement('gift_card_claim', id, timestamp,
      sql`EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases WHERE id = ${id} AND status = 'paid' AND provider_session_id = ${session.id})`)),
  ]);
  await sendCommerceEmailNow(env, 'gift_card_claim', id, composeGiftCardClaimEmail);
  return { success: true, purchaseId: id };
}

/** A claim link works once, for 7 days. */
export const GIFT_CARD_CLAIM_SECONDS = 7 * 24 * 60 * 60;
/** Claim requests one client network (an IPv4 address or an IPv6 /64) may make per hour. */
export const GIFT_CARD_CLAIMS_PER_NETWORK_PER_HOUR = 20;
const CLAIM_TOKEN = /^[0-9a-f]{64}$/;

/** The storefront page a claim link opens. The token is in the fragment, so it never reaches the server's logs. */
const claimUrl = (origin: string, token: string) => `${origin}/gift-cards/claim#token=${token}`;

/** The purchase, its buyer and the card that holds its value now: the purchased card or its replacement. */
function claimTarget(db: CommerceDb, purchaseId: string) {
  return db.select({ id: giftCardPurchases.id, buyerEmail: giftCardPurchases.buyerEmail, amountCents: giftCardPurchases.amountCents,
    currency: giftCardPurchases.currency, cardId: giftCards.id, cardStatus: giftCards.status })
    .from(giftCardPurchases).leftJoin(giftCards, eq(giftCards.id, currentCard(giftCardPurchases.id)))
    .where(eq(giftCardPurchases.id, purchaseId)).get();
}
type ClaimTarget = NonNullable<Awaited<ReturnType<typeof claimTarget>>>;

/**
 * A new claim link for a card; only the token's hash is stored, so the token is returned this once.
 * The statement returns the link's id when it made the link, and makes none unless `condition` holds.
 */
async function newClaimLink(target: ClaimTarget & { cardId: string }, now: number,
  { resend, condition }: { resend?: { actor: string; reason: string }; condition?: SQL } = {}) {
  const token = randomHex(32);
  const id = `gclaim_${crypto.randomUUID()}`;
  const expiresAt = now + GIFT_CARD_CLAIM_SECONDS;
  return { id, token, expiresAt, statement: sql`INSERT INTO _ecommerce_gift_card_claims
      (id,token_hash,purchase_id,card_id,expires_at,created_at,created_by,reason)
      SELECT ${id},${await hashGiftCardSecret(token)},${target.id},${target.cardId},${expiresAt},${now},
        ${resend?.actor ?? null},${resend?.reason ?? null} WHERE ${condition ?? sql`1`} RETURNING id` };
}

/** Revokes a claim link that was not used; a batch item. */
const revokeClaimLinkStatement = (db: CommerceDb, id: string) => db.update(giftCardClaims).set({ revokedAt: new Date() })
  .where(and(eq(giftCardClaims.id, id), isNull(giftCardClaims.revokedAt)));

function claimEmail(setup: CommerceEmailSetup, target: ClaimTarget, link: { token: string; expiresAt: number }) {
  const email: GiftCardClaimEmail = {
    store: setup.store,
    purchase: { id: target.id, amountCents: target.amountCents, currency: target.currency },
    claim: { url: claimUrl(setup.store.origin!, link.token), expiresAt: new Date(link.expiresAt * 1000) },
  };
  return applyEmailTemplate(setup, 'giftCardClaim', email, giftCardClaimEmail(email));
}

/**
 * The email sent after a purchase is paid: a new one-time link, never the code. The link is made when
 * the email is sent and revoked if the send fails, so a retry sends a new one. A purchase whose card
 * is no longer active gets no link.
 */
export const composeGiftCardClaimEmail: CommerceEmailComposer = async (env, purchaseId, setup, now) => {
  const db = commerceDb(env);
  const target = await claimTarget(db, purchaseId);
  if (!target) return { cancel: 'not_found' };
  if (!target.cardId || target.cardStatus !== 'active') return { cancel: 'not_claimable' };
  const to = bareEmailAddress(target.buyerEmail);
  if (!to) return { fail: 'invalid_recipient' };
  // Only while this Worker still holds the email: one whose lease ran out, and whose email another Worker
  // or an administrator's resend took over, makes no link and sends nothing.
  const link = await newClaimLink({ ...target, cardId: target.cardId }, now,
    { condition: commerceEmailHeld('gift_card_claim', purchaseId, now) });
  if (!await db.get<{ id: string }>(link.statement)) return { cancel: 'superseded' };
  return { to, message: await claimEmail(setup, target, link), onFailure: () => revokeClaimLinkStatement(db, link.id).run() };
};

/**
 * Shows the code of the card a claim link was made for, once. The link must be unused, not revoked and
 * not expired, and its card active: a replacement voids the card it replaces, so links made before it
 * stop working. Of concurrent requests with one link, only one gets the code. Returns null for every
 * link that cannot be used.
 */
export async function claimGiftCardCode(env: TalismanEnv, token: unknown) {
  if (typeof token !== 'string' || !CLAIM_TOKEN.test(token)) return null;
  const now = Math.floor(Date.now() / 1000);
  const db = commerceDb(env);
  const claim = await db.select({ id: giftCardClaims.id, cardId: giftCardClaims.cardId,
    codeHash: giftCards.codeHash, encryptedCode: giftCards.encryptedCode, balanceCents: giftCards.balanceCents,
    currency: giftCards.currency })
    .from(giftCardClaims).innerJoin(giftCards, eq(giftCards.id, giftCardClaims.cardId))
    .where(and(eq(giftCardClaims.tokenHash, await hashGiftCardSecret(token)), isNull(giftCardClaims.usedAt),
      isNull(giftCardClaims.revokedAt), gt(giftCardClaims.expiresAt, at(now)), eq(giftCards.status, 'active'))).get();
  if (!claim) return null;
  // Decrypted before the link is used up, so a missing key leaves the link working.
  const code = await decryptCardSecret(await giftCardKeyring(env),
    { id: claim.cardId, codeHash: claim.codeHash, encryptedCode: claim.encryptedCode });
  const used = await db.update(giftCardClaims).set({ usedAt: at(now) })
    .where(and(eq(giftCardClaims.id, claim.id), isNull(giftCardClaims.usedAt), isNull(giftCardClaims.revokedAt),
      gt(giftCardClaims.expiresAt, at(now)),
      exists(db.select({ one: sql`1` }).from(giftCards).where(and(eq(giftCards.id, claim.cardId), eq(giftCards.status, 'active'))))))
    .returning({ id: giftCardClaims.id });
  if (!used.length) return null;
  return { code, balanceCents: claim.balanceCents, currency: claim.currency };
}

const resendSchema = z.object({
  purchaseId: purchaseIdSchema,
  reason: z.string().trim().min(8).max(500),
}).strict();

/**
 * Emails the buyer of a purchase a new claim link for the card that holds its value now, for example
 * after the first email was lost or a replacement card was issued. The new link records the
 * administrator and the reason. While the email is sent, the purchase's automatic claim email is held
 * with the lease a sending Worker takes, so the two are never sent at once; a resend is refused while
 * the automatic email is being sent. Only after the new email is sent do the links made before it stop
 * working and a claim email that was still waiting get cancelled. When the send fails, only the new
 * link is revoked: earlier links keep working, the automatic email keeps its retries, and the action
 * can be repeated.
 */
export async function resendGiftCardClaimLink(env: TalismanEnv, actor: string, input: unknown) {
  const values = resendSchema.parse(input);
  if (!actor.trim()) throw new Error('Administrator identity is required');
  const setup = await commerceEmailSetup(env);
  const missing = missingEmailSettings(setup, 'gift_card_claim');
  if (missing.length) throw new Error(`Email needs ${missing.join(', ')} before a claim link can be sent`);
  const db = commerceDb(env);
  const target = await claimTarget(db, values.purchaseId);
  if (!target) throw new Error('Gift card purchase not found');
  if (!target.cardId || target.cardStatus !== 'active') {
    throw new Error('A claim link can be sent only while the card that holds the purchase\'s value is active');
  }
  const to = bareEmailAddress(target.buyerEmail);
  if (!to) throw new Error('The purchase has no valid buyer address');
  const now = Math.floor(Date.now() / 1000);
  const hold = await holdCommerceEmail(env, 'gift_card_claim', values.purchaseId, now);
  if (hold === 'busy') {
    throw new Error('The claim email is being sent right now; reload in a few minutes and resend it only if it was not sent');
  }
  const release = hold === null ? [] : [releaseCommerceEmailStatement(db, 'gift_card_claim', values.purchaseId, hold)];
  const link = await newClaimLink({ ...target, cardId: target.cardId }, now, { resend: { actor, reason: values.reason } });
  try {
    await db.get(link.statement);
  } catch (cause) {
    await commitBatch(db, release);
    throw new Error('The purchase\'s card changed while the link was being made; reload and try again', { cause });
  }
  try {
    await sendCommerceMessage(env, setup, 'gift_card_claim', to, await claimEmail(setup, target, link));
  } catch (error) {
    // The new link was in no email, so it is harmless if this fails; the hold then ends with its lease.
    await commitBatch(db, [revokeClaimLinkStatement(db, link.id), ...release]).catch(() => undefined);
    const code = emailErrorCode(error);
    console.warn('[commerce] Gift card claim link not sent', { purchase: values.purchaseId, code });
    throw new Error(`The claim email could not be sent (${code}); earlier links still work. Try again later`);
  }
  // Links made before this one stop working, by insertion order, so of two resends at once the later
  // link is the one that keeps working.
  try {
    await commitBatch(db, [
      db.update(giftCardClaims).set({ revokedAt: at(now) })
        .where(and(eq(giftCardClaims.purchaseId, values.purchaseId), isNull(giftCardClaims.usedAt), isNull(giftCardClaims.revokedAt),
          lt(sql`rowid`, db.select({ rowid: sql<number>`rowid` }).from(giftCardClaims).where(eq(giftCardClaims.id, link.id))))),
      ...(hold === null ? [] : [supersedeCommerceEmailStatement(db, 'gift_card_claim', values.purchaseId, hold)]),
    ]);
  } catch (cause) {
    throw new Error('The claim email was sent, but earlier links still work; resend it again to stop them', { cause });
  }
  return { purchaseId: values.purchaseId, claimId: link.id, expiresAt: new Date(link.expiresAt * 1000).toISOString() };
}

export async function expireGiftCardPurchase(env: TalismanEnv, id: string, sessionId: string) {
  await commerceDb(env).update(giftCardPurchases).set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(eq(giftCardPurchases.id, id), eq(giftCardPurchases.providerSessionId, sessionId),
      eq(giftCardPurchases.status, 'pending')));
}

/**
 * Repair a paid or expired purchase when its signed webhook did not arrive. A purchase parked for
 * review is returned as pending without asking Stripe. Failures that another attempt cannot change (a
 * session Stripe does not have, a session of the other Stripe mode, a completed payment that does not
 * match) throw a permanent ReconcileFailure, which reconcileCommerce parks.
 */
export async function reconcileGiftCardPurchase(env: TalismanEnv, adapter: PaymentProviderAdapter | undefined, id: string) {
  const db = commerceDb(env);
  const purchase = await db.select().from(giftCardPurchases).where(eq(giftCardPurchases.id, id)).get();
  if (!purchase || purchase.status !== 'pending' || !purchase.providerSessionId) return null;
  if (purchase.reconcileReviewAt) return { status: 'pending', review: true };
  if (adapter?.providerId !== 'stripe' || !adapter.getCheckoutSession) {
    throw new ReconcileFailure('provider_not_configured', 'Stripe session lookup is required for gift card reconciliation');
  }
  // Checked once Stripe is configured, whose key matches the mode setting (see reconcilePending).
  assertStoreStripeMode(env, purchase.providerSessionId);
  const session = await adapter.getCheckoutSession(purchase.providerSessionId)
    .catch((error: unknown) => { throw sessionLookupFailure(error); });
  if (session.status === 'expired') {
    await expireGiftCardPurchase(env, id, purchase.providerSessionId);
    return { status: 'cancelled' };
  }
  if (session.status === 'complete' && session.paymentStatus === 'paid') {
    if (session.amountTotal !== purchase.amountCents || session.currency?.toLowerCase() !== purchase.currency.toLowerCase() ||
      !session.paymentIntentId) {
      throw new ReconcileFailure('payment_mismatch', 'Gift card payment does not match purchase');
    }
    await confirmGiftCardPurchase(env, {
      id: purchase.providerSessionId,
      metadata: { giftCardPurchaseId: id },
      amount_total: session.amountTotal ?? undefined,
      currency: session.currency ?? undefined,
      payment_status: session.paymentStatus,
      payment_intent: session.paymentIntentId ?? undefined,
    });
    return { status: 'paid' };
  }
  return { status: 'pending' };
}

export async function getPurchasedGiftCard(env: TalismanEnv, id: string, accessToken: string | undefined) {
  if (!/^gp_[0-9a-f-]{36}$/.test(id) || !accessToken) return null;
  const db = commerceDb(env);
  const purchase = await db.select().from(giftCardPurchases).where(eq(giftCardPurchases.id, id)).get();
  if (!purchase || purchase.accessTokenHash !== await hashGiftCardSecret(accessToken)) return null;
  const card = await db.select().from(giftCards).where(eq(giftCards.purchaseId, id)).get();
  return { status: purchase.status, amountCents: purchase.amountCents,
    // A card whose value moved to a replacement is void, and its code no longer shown.
    code: card && purchase.status === 'paid' && card.status !== 'void'
      ? await decryptCardSecret(await giftCardKeyring(env), card) : null,
    balanceCents: card?.balanceCents ?? null,
    // A pending purchase whose payment check is parked stays pending until an administrator decides.
    paymentUnderReview: purchase.status === 'pending' && purchase.reconcileReviewAt !== null };
}

/**
 * Statements that apply a purchase's review hold to every card it funds: the purchased card and the
 * replacements that took over its value. While the purchase is held for review, none of them can be
 * spent; the hold marks the cards it suspends, so reinstating the purchase reactivates only those. A
 * fully refunded purchase whose cards were never spent on an order is settled at once: what is left on
 * them is reversed and they are voided. A purchase with no card left to hold leaves review as refunded
 * or partially refunded. Add them to the batch that moves the purchase to 'review'.
 */
export function giftCardPurchaseHoldStatements(purchaseId: string, timestamp: number): SQL[] {
  // Reversals of earlier refunds and moves to a replacement are not spending; orders are, including a
  // checkout in progress (its reservation is in the ledger until released).
  const unspentFullRefund = sql`EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases p
    WHERE p.id = ${purchaseId} AND p.status = 'review' AND p.provider_refunded_cents >= p.amount_cents
      AND NOT ${pendingCheckout(p.id)}
      AND (SELECT COALESCE(SUM(l.amount_cents),0) FROM _ecommerce_gift_card_ledger l
        JOIN _ecommerce_gift_cards f ON f.id = l.card_id
        WHERE (f.purchase_id = p.id OR f.replaces_purchase_id = p.id)
          AND l.kind IN ('reserve','release','refund_restore')) = 0)`;
  return [
    sql`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,purchase_id,kind,amount_cents,created_at)
      SELECT 'gcl_purchase_reversal_' || c.id,c.id,${purchaseId},'purchase_reversal',-c.balance_cents,${timestamp}
      FROM _ecommerce_gift_cards c WHERE (c.purchase_id = ${purchaseId} OR c.replaces_purchase_id = ${purchaseId})
        AND c.status <> 'void' AND c.balance_cents > 0 AND ${unspentFullRefund}
      ON CONFLICT(id) DO NOTHING`,
    sql`UPDATE _ecommerce_gift_cards SET status = 'void',held_for_review = 0,updated_at = ${timestamp}
      WHERE (purchase_id = ${purchaseId} OR replaces_purchase_id = ${purchaseId}) AND status <> 'void' AND ${unspentFullRefund}`,
    sql`UPDATE _ecommerce_gift_card_purchases
      SET status = CASE WHEN provider_refunded_cents >= amount_cents THEN 'refunded' ELSE 'partially_refunded' END,
        refund_adjusted_cents = provider_refunded_cents,updated_at = ${timestamp}
      WHERE id = ${purchaseId} AND status = 'review' AND NOT EXISTS (SELECT 1 FROM _ecommerce_gift_cards c
        WHERE (c.purchase_id = ${purchaseId} OR c.replaces_purchase_id = ${purchaseId}) AND c.status <> 'void')`,
    sql`UPDATE _ecommerce_gift_cards SET status = 'suspended',held_for_review = 1,updated_at = ${timestamp}
      WHERE (purchase_id = ${purchaseId} OR replaces_purchase_id = ${purchaseId}) AND status = 'active'
        AND EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases p WHERE p.id = ${purchaseId} AND p.status = 'review')`,
  ];
}

/**
 * Statements that lift a purchase's hold once it needs no decision: the cards the hold suspended become
 * active again, and a card an administrator suspended stays so. Add them after the statement that moves
 * the purchase out of review; while it is still held they change nothing.
 */
export function giftCardPurchaseReleaseStatements(purchaseId: string, timestamp: number): SQL[] {
  return [
    sql`UPDATE _ecommerce_gift_cards SET status = 'active',held_for_review = 0,updated_at = ${timestamp}
      WHERE (purchase_id = ${purchaseId} OR replaces_purchase_id = ${purchaseId}) AND status = 'suspended' AND held_for_review = 1
        AND EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases p WHERE p.id = ${purchaseId} AND ${settledPurchase(p)})`,
  ];
}

/**
 * Statements for a purchase whose payment a lost dispute took back: every card it funds is voided and
 * what is left on them is reversed, and the purchase becomes refunded. Value already spent on orders
 * stays spent. While a checkout in progress holds value on the cards, nothing changes, like the review
 * 'void' outcome; add the hold statements first, so nothing more is spent meanwhile.
 */
export function giftCardPurchaseChargebackStatements(purchaseId: string, timestamp: number): SQL[] {
  const clear = sql`NOT EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases p WHERE p.id = ${purchaseId} AND ${pendingCheckout(p.id)})`;
  return [
    sql`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,purchase_id,kind,amount_cents,created_at)
      SELECT 'gcl_chargeback_' || c.id,c.id,${purchaseId},'purchase_reversal',-c.balance_cents,${timestamp}
      FROM _ecommerce_gift_cards c WHERE (c.purchase_id = ${purchaseId} OR c.replaces_purchase_id = ${purchaseId})
        AND c.status <> 'void' AND c.balance_cents > 0 AND ${clear}
      ON CONFLICT(id) DO NOTHING`,
    sql`UPDATE _ecommerce_gift_cards SET status = 'void',held_for_review = 0,updated_at = ${timestamp}
      WHERE (purchase_id = ${purchaseId} OR replaces_purchase_id = ${purchaseId}) AND status <> 'void' AND ${clear}`,
    sql`UPDATE _ecommerce_gift_card_purchases
      SET status = 'refunded',refund_adjusted_cents = provider_refunded_cents,updated_at = ${timestamp}
      WHERE id = ${purchaseId} AND status IN ('paid','partially_refunded','refunded','review')
        AND NOT EXISTS (SELECT 1 FROM _ecommerce_gift_cards c
          WHERE (c.purchase_id = ${purchaseId} OR c.replaces_purchase_id = ${purchaseId}) AND c.status <> 'void')`,
  ];
}

export async function recordGiftCardPurchaseRefund(env: TalismanEnv, params: {
  paymentIntentId: string; amount: number; amountRefunded: number; currency: string;
}) {
  const db = commerceDb(env);
  const purchase = await db.select().from(giftCardPurchases)
    .where(eq(giftCardPurchases.paymentIntentId, params.paymentIntentId)).get();
  if (!purchase) return null;
  if (purchase.amountCents !== params.amount ||
    params.currency.toLowerCase() !== purchase.currency.toLowerCase() ||
    !Number.isSafeInteger(params.amountRefunded) || params.amountRefunded < 0 ||
    params.amountRefunded > purchase.amountCents) {
    throw new WebhookMismatchError('refund_mismatch', 'Gift card refund does not match purchase');
  }
  if (params.amountRefunded <= purchase.providerRefundedCents) return { success: true, duplicate: true };
  const timestamp = Math.floor(Date.now() / 1000);
  // Each new refund total holds the purchase for review, including one already resolved. The hold
  // statements work from the stored state, so a stale or repeated event only reapplies it.
  await commitBatch(db, [
    db.update(giftCardPurchases).set({ status: 'review', providerRefundedCents: params.amountRefunded, updatedAt: at(timestamp) })
      .where(and(eq(giftCardPurchases.id, purchase.id), lt(giftCardPurchases.providerRefundedCents, params.amountRefunded))),
    ...giftCardPurchaseHoldStatements(purchase.id, timestamp).map((statement) => db.run(statement)),
  ]);
  const current = await db.select({ status: giftCardPurchases.status }).from(giftCardPurchases)
    .where(eq(giftCardPurchases.id, purchase.id)).get();
  return { success: true, purchaseId: purchase.id, status: current?.status ?? 'review' };
}

const reviewSchema = z.object({
  purchaseId: purchaseIdSchema,
  outcome: z.enum(['reinstate', 'void']),
  reason: z.string().trim().min(8).max(500),
  // The refund total the administrator decided on; a refund recorded since then stops the action.
  refundedCents: z.number().int().positive(),
}).strict();

/**
 * Resolves a purchase held for review after a provider refund. 'reinstate' takes the part of the
 * refund not yet taken off the purchase's cards off the card that holds its value, and lifts the hold:
 * the cards the hold suspended become active again, and a card an administrator suspended stays so.
 * 'void' voids the purchase's cards and reverses what is left on them; it waits while a checkout in
 * progress holds value on them. Either way the purchase becomes partially refunded or refunded by its
 * refund total, and _ecommerce_gift_card_reviews records who decided, why and the amounts.
 */
export async function resolveGiftCardReview(env: TalismanEnv, actor: string, input: unknown) {
  const values = reviewSchema.parse(input);
  if (!actor.trim()) throw new Error('Administrator identity is required');
  const db = commerceDb(env);
  const purchase = await reviewQuery(db).where(eq(p.id, values.purchaseId)).get();
  if (purchase?.status !== 'review') throw new Error('Gift card purchase is not held for review');
  const disputed = await db.select({ open: openDispute(P_ID) }).from(p).where(eq(p.id, values.purchaseId)).get();
  if (disputed?.open) throw new Error('A payment dispute is open for this purchase; its cards stay held until the dispute closes');
  if (purchase.refundedCents !== values.refundedCents) {
    throw new Error('Another refund was recorded for this purchase; reload and review it again');
  }
  if (values.outcome === 'reinstate' && !purchase.cardId) {
    throw new Error('Every card of this purchase is void, so it cannot be reinstated');
  }
  if (values.outcome === 'reinstate' && (purchase.balanceCents ?? 0) < purchase.refundedCents - purchase.adjustedCents) {
    throw new Error('The card balance does not cover the refund; void the card instead');
  }
  if (values.outcome === 'void' && purchase.pendingCents > 0) {
    throw new Error('A checkout in progress holds value on this purchase\'s card; void it once that checkout completes or expires');
  }
  const reviewId = `gcrev_${crypto.randomUUID()}`;
  const timestamp = Math.floor(Date.now() / 1000);
  // Every statement repeats the state the administrator decided on: the purchase is still held for
  // review at the refund total they saw, and this review was recorded. A refund recorded in between
  // makes the whole batch change nothing.
  const held = sql`EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases
    WHERE id = ${values.purchaseId} AND status = 'review' AND provider_refunded_cents = ${values.refundedCents})`;
  const recorded = sql`EXISTS (SELECT 1 FROM _ecommerce_gift_card_reviews WHERE id = ${reviewId})`;
  const funded = or(eq(giftCards.purchaseId, values.purchaseId), eq(giftCards.replacesPurchaseId, values.purchaseId));
  const review = values.outcome === 'reinstate'
    // Recorded only while the card that holds the purchase's value covers the refund not yet taken off.
    ? db.all<{ adjustment_cents: number }>(sql`INSERT INTO _ecommerce_gift_card_reviews
      (id,purchase_id,card_id,outcome,refunded_cents,adjustment_cents,admin_actor,reason,created_at)
      SELECT ${reviewId},p.id,c.id,'reinstate',p.provider_refunded_cents,p.provider_refunded_cents - p.refund_adjusted_cents,${actor},${values.reason},${timestamp}
      FROM _ecommerce_gift_card_purchases p JOIN _ecommerce_gift_cards c ON c.id = ${currentCard(p.id)}
      WHERE p.id = ${values.purchaseId} AND p.status = 'review' AND p.provider_refunded_cents = ${values.refundedCents}
        AND c.balance_cents >= p.provider_refunded_cents - p.refund_adjusted_cents AND NOT ${openDispute(p.id)}
      RETURNING adjustment_cents`)
    // Recorded only while no checkout in progress holds value on the purchase's cards, so nothing is
    // released onto them once they are void.
    : db.all<{ adjustment_cents: number }>(sql`INSERT INTO _ecommerce_gift_card_reviews
      (id,purchase_id,card_id,outcome,refunded_cents,adjustment_cents,admin_actor,reason,created_at)
      SELECT ${reviewId},p.id,COALESCE(${currentCard(p.id)},
          (SELECT o.id FROM _ecommerce_gift_cards o WHERE o.purchase_id = p.id)),
        'void',p.provider_refunded_cents,${cardValue(p.id)},${actor},${values.reason},${timestamp}
      FROM _ecommerce_gift_card_purchases p
      WHERE p.id = ${values.purchaseId} AND p.status = 'review' AND p.provider_refunded_cents = ${values.refundedCents}
        AND NOT ${pendingCheckout(p.id)} AND NOT ${openDispute(p.id)}
      RETURNING adjustment_cents`);
  const effects: BatchItem<'sqlite'>[] = values.outcome === 'reinstate' ? [
    db.run(sql`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,purchase_id,kind,amount_cents,created_at)
      SELECT 'gcl_' || r.id,r.card_id,r.purchase_id,'purchase_reversal',-r.adjustment_cents,r.created_at
      FROM _ecommerce_gift_card_reviews r WHERE r.id = ${reviewId} AND r.adjustment_cents > 0 AND ${held}`),
    db.update(giftCards).set({ status: 'active', heldForReview: false, updatedAt: at(timestamp) })
      .where(and(funded, eq(giftCards.status, 'suspended'), eq(giftCards.heldForReview, true), held, recorded)),
  ] : [
    db.run(sql`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,purchase_id,kind,amount_cents,created_at)
      SELECT ${`gcl_${reviewId}`} || '_' || id,id,${values.purchaseId},'purchase_reversal',-balance_cents,${timestamp}
      FROM _ecommerce_gift_cards WHERE (purchase_id = ${values.purchaseId} OR replaces_purchase_id = ${values.purchaseId})
        AND status <> 'void' AND balance_cents > 0 AND ${held} AND ${recorded}`),
    db.update(giftCards).set({ status: 'void', heldForReview: false, updatedAt: at(timestamp) })
      .where(and(funded, ne(giftCards.status, 'void'), held, recorded)),
  ];
  const settled = db.update(giftCardPurchases).set({
    status: sql`CASE WHEN ${giftCardPurchases.providerRefundedCents} >= ${giftCardPurchases.amountCents} THEN 'refunded' ELSE 'partially_refunded' END`,
    refundAdjustedCents: giftCardPurchases.providerRefundedCents, updatedAt: at(timestamp),
  }).where(and(eq(giftCardPurchases.id, values.purchaseId), eq(giftCardPurchases.status, 'review'),
    eq(giftCardPurchases.providerRefundedCents, values.refundedCents), recorded));
  const [[adjustment]] = await db.batch([review, ...effects, settled]);
  if (!adjustment) throw new Error('The purchase changed while it was being resolved; reload and review it again');
  return { id: reviewId, purchaseId: values.purchaseId, outcome: values.outcome,
    adjustmentCents: adjustment.adjustment_cents,
    status: values.refundedCents >= purchase.amountCents ? 'refunded' : 'partially_refunded' };
}

const refundSchema = z.object({
  orderId: z.string().regex(/^ord_[0-9a-f-]{36}$/),
  reason: z.string().trim().min(8).max(500),
  amountCents: z.number().int().positive().optional(),
}).strict();

/** Restore part of the gift-card tender while leaving a split-paid order open. */
export async function refundGiftCardTender(env: TalismanEnv, actor: string, input: unknown) {
  const values = refundSchema.parse(input);
  if (!actor.trim()) throw new Error('Administrator identity is required');
  const db = commerceDb(env);
  const current = await db.select({ giftCardId: orders.giftCardId, giftCardApplied: orders.giftCardApplied,
    giftCardRefundedCents: orders.giftCardRefundedCents, status: orders.status, referralCode: orders.referralCode })
    .from(orders).where(eq(orders.id, values.orderId)).get();
  if (!current?.giftCardId || !['paid', 'fulfilled', 'partially_refunded'].includes(current.status)) {
    throw new Error('Order is unavailable for a gift card refund');
  }
  const remaining = current.giftCardApplied - current.giftCardRefundedCents;
  if (!values.amountCents || values.amountCents > remaining) throw new Error('Refund exceeds gift card payment');
  const id = `gfr_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  const statements: BatchItem<'sqlite'>[] = [db.insert(giftCardRefunds).values({ id, cardId: current.giftCardId, orderId: values.orderId,
    amountCents: values.amountCents, adminActor: actor, reason: values.reason, createdAt: at(now) })];
  // A refund that leaves less than the referral minimum paid voids the referral and reverses released awards.
  if (current.referralCode) {
    const policy = await getReferralPolicy(env);
    statements.push(...referralReversalStatements(values.orderId, { minOrderCents: policy.minOrderCents, now })
      .map((statement) => db.run(statement)));
  }
  await commitBatch(db, statements);
  return { id, orderId: values.orderId, amountCents: values.amountCents };
}

/** Refund a zero-provider gift-card order, including any promotional credit used with it. */
export async function refundGiftCardOnlyOrder(env: TalismanEnv, actor: string, input: unknown) {
  const values = refundSchema.parse(input);
  if (!actor.trim() || values.amountCents !== undefined) throw new Error('Invalid full refund request');
  const db = commerceDb(env);
  const order = await db.select({ id: orders.id, giftCardId: orders.giftCardId,
    giftCardApplied: orders.giftCardApplied, giftCardRefundedCents: orders.giftCardRefundedCents,
    creditApplied: orders.creditApplied, paymentProvider: orders.paymentProvider, totalAmount: orders.totalAmount,
    status: orders.status, userId: orders.userId }).from(orders).where(eq(orders.id, values.orderId)).get();
  if (!order?.giftCardId || order.paymentProvider !== 'gift_card' || order.totalAmount !== 0 ||
    !['paid', 'partially_refunded', 'fulfilled'].includes(order.status)) {
    throw new Error('Only paid gift-card-only orders can be refunded here');
  }
  const now = Math.floor(Date.now() / 1000);
  const remaining = order.giftCardApplied - order.giftCardRefundedCents;
  const confirmed = (redemptions: typeof giftCardRedemptions | typeof discountRedemptions) =>
    and(eq(redemptions.orderId, order.id), eq(redemptions.status, 'confirmed'));
  await commitBatch(db, [
    db.insert(giftCardOrderRefunds).values({ orderId: order.id, adminActor: actor, reason: values.reason, createdAt: at(now) }),
    ...(remaining > 0 ? [db.insert(giftCardRefunds).values({ id: `gfr_full_${order.id}`, cardId: order.giftCardId, orderId: order.id,
      amountCents: remaining, adminActor: actor, reason: values.reason, createdAt: at(now) })] : []),
    db.update(orders).set({ status: 'refunded', updatedAt: at(now) })
      .where(and(eq(orders.id, order.id), eq(orders.paymentProvider, 'gift_card'), eq(orders.totalAmount, 0),
        inArray(orders.status, ['paid', 'fulfilled', 'partially_refunded']))),
    db.update(giftCardRedemptions).set({ status: 'refunded', updatedAt: at(now) }).where(confirmed(giftCardRedemptions)),
    db.update(discountRedemptions).set({ status: 'refunded', updatedAt: at(now) }).where(confirmed(discountRedemptions)),
    ...(order.creditApplied > 0 && order.userId ? [db.insert(creditLedger).values({ id: `credit_refund_${order.id}`,
      accountId: order.userId, orderId: order.id, kind: 'purchase_credit_refund', amountCents: order.creditApplied, createdAt: at(now) })
      .onConflictDoNothing({ target: [creditLedger.orderId, creditLedger.kind] })] : []),
    db.update(payments).set({ status: 'refunded' }).where(eq(payments.orderId, order.id)),
  ]);
  return { orderId: order.id, status: 'refunded' };
}
