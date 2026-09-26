import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { createDbClient, type TalismanEnv } from 'talisman-cms/client';
import { readSetting } from 'talisman-cms/env';
import { giftCardPurchases, giftCards, giftCardLedger } from './schema';
import type { PaymentProviderAdapter } from './payments';
import { getReferralPolicy, referralReversalStatements } from './referrals';
import { readStoreSettings } from './store-settings';
import { minimumChargeAmount } from './money';

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
  const page = await env.DB.prepare(`SELECT id,code_hash,encrypted_code FROM _ecommerce_gift_cards
    WHERE substr(encrypted_code,1,?) <> ? AND id > ? ORDER BY id LIMIT ?`)
    .bind(prefix.length, prefix, after, limit)
    .all<{ id: string; code_hash: string; encrypted_code: string }>();
  const rows = page.results ?? [];
  const statements: D1PreparedStatement[] = [];
  const failed: string[] = [];
  for (const row of rows) {
    try {
      const code = await decryptCardSecret(keys, { id: row.id, codeHash: row.code_hash, encryptedCode: row.encrypted_code });
      // Only while the stored ciphertext is still the one decrypted here.
      statements.push(env.DB.prepare(`UPDATE _ecommerce_gift_cards SET encrypted_code = ?
        WHERE id = ? AND encrypted_code = ? RETURNING id`)
        .bind(await encryptCardSecret(current, row.id, code), row.id, row.encrypted_code));
    } catch {
      failed.push(row.id);
    }
  }
  const results = statements.length ? await env.DB.batch(statements) : [];
  return { keyId: current.id, reencrypted: results.reduce((sum, result) => sum + (result.results?.length ?? 0), 0),
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
  const row = await env.DB.prepare(`SELECT
      COALESCE(SUM(substr(encrypted_code,1,3) = 'v2:' AND substr(encrypted_code,1,?) <> ?),0) AS previousKeyCodes,
      COALESCE(SUM(substr(encrypted_code,1,3) <> 'v2:'),0) AS legacyCodes
    FROM _ecommerce_gift_cards`).bind(prefix.length, prefix)
    .first<{ previousKeyCodes: number; legacyCodes: number }>();
  return { keyId: current.id, previousKeyCodes: row?.previousKeyCodes ?? 0, legacyCodes: row?.legacyCodes ?? 0 };
}

// Paid, or refunded with nothing left to decide: not held for review, and every refund taken off its cards.
const settledPurchase = `(p.status = 'paid' OR (p.status IN ('partially_refunded','refunded')
  AND p.refund_adjusted_cents = p.provider_refunded_cents))`;
// The cards a purchase funds are its purchased card and the replacements that took over its value. The
// one that holds the value now is the card that is not void, newest replacement first: each replacement
// voids the cards it replaces, so there is normally only one.
const currentCard = (purchase: string) => `SELECT k.id FROM _ecommerce_gift_cards k
  WHERE (k.purchase_id = ${purchase} OR k.replaces_purchase_id = ${purchase}) AND k.status <> 'void'
  ORDER BY k.source = 'admin' DESC,k.created_at DESC,k.id DESC LIMIT 1`;
// A checkout in progress holds value on one of the purchase's cards. Its release would credit that card,
// so the card must not be voided before the checkout completes or expires.
const pendingCheckout = (purchase: string) => `EXISTS (SELECT 1 FROM _ecommerce_gift_card_redemptions r
  JOIN _ecommerce_gift_cards f ON f.id = r.card_id
  WHERE (f.purchase_id = ${purchase} OR f.replaces_purchase_id = ${purchase}) AND r.status = 'reserved')`;
const cardValue = (purchase: string) => `(SELECT COALESCE(SUM(f.balance_cents),0) FROM _ecommerce_gift_cards f
  WHERE (f.purchase_id = ${purchase} OR f.replaces_purchase_id = ${purchase}) AND f.status <> 'void')`;

const units = (cents: number, currency: string) => `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;

/** Explains why a purchase's card cannot be replaced by a card of this amount. */
async function assertReplaceable(env: TalismanEnv, purchaseId: string, amountCents: number) {
  const purchase = await env.DB.prepare(`SELECT p.status,p.currency,${settledPurchase} AS settled,
      ${cardValue('p.id')} AS value,${pendingCheckout('p.id')} AS pending
    FROM _ecommerce_gift_card_purchases p WHERE p.id = ?`).bind(purchaseId)
    .first<{ status: string; currency: string; settled: number; value: number; pending: number }>();
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
  if (replaces) await assertReplaceable(env, replaces, amountCents);
  const id = `gift_${crypto.randomUUID()}`;
  const secret = await newCardSecret(env, id);
  const timestamp = Math.floor(Date.now() / 1000);
  // A replacement takes over exactly the value left on the purchase's cards, which are emptied and voided
  // in the same batch, so the purchase never funds two spendable cards and the lost code stops working.
  const statements = [
    env.DB.prepare(`INSERT INTO _ecommerce_gift_cards
      (id,code_hash,code_suffix,encrypted_code,source,admin_actor,admin_reason,replaces_purchase_id,initial_cents,balance_cents,currency,status,created_at,updated_at)
      SELECT ?,?,?,?,'admin',?,?,?,?,0,?,'active',?,?
      WHERE ? IS NULL OR EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases p
        WHERE p.id = ? AND p.currency = ? AND p.status IN ('paid','partially_refunded') AND ${settledPurchase}
          AND NOT ${pendingCheckout('p.id')} AND ${cardValue('p.id')} = ?)
      RETURNING id`)
      .bind(id, secret.codeHash, secret.codeSuffix, secret.encryptedCode, actor, reason, replaces, amountCents,
        currency, timestamp, timestamp, replaces, replaces, currency, amountCents),
    env.DB.prepare(`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,purchase_id,kind,amount_cents,created_at)
      SELECT ?,id,replaces_purchase_id,'issue',initial_cents,? FROM _ecommerce_gift_cards WHERE id = ?`)
      .bind(`gcl_issue_${id}`, timestamp, id),
  ];
  if (replaces) {
    const replacementIssued = `EXISTS (SELECT 1 FROM _ecommerce_gift_cards n WHERE n.id = ?)`;
    statements.push(
      env.DB.prepare(`INSERT INTO _ecommerce_gift_card_ledger
        (id,card_id,purchase_id,kind,amount_cents,created_at)
        SELECT 'gcl_replaced_' || c.id,c.id,?,'purchase_reversal',-c.balance_cents,?
        FROM _ecommerce_gift_cards c WHERE (c.purchase_id = ? OR c.replaces_purchase_id = ?) AND c.id <> ?
          AND c.status <> 'void' AND c.balance_cents > 0 AND ${replacementIssued}`)
        .bind(replaces, timestamp, replaces, replaces, id, id),
      env.DB.prepare(`UPDATE _ecommerce_gift_cards SET status = 'void',held_for_review = 0,updated_at = ?
        WHERE (purchase_id = ? OR replaces_purchase_id = ?) AND id <> ? AND status <> 'void' AND ${replacementIssued}`)
        .bind(timestamp, replaces, replaces, id, id));
  }
  const [inserted] = await env.DB.batch<{ id: string }>(statements);
  if (!inserted.results?.length) throw new Error('The purchase changed while its card was being replaced; reload and try again');
  return { id, code: secret.code, amountCents, currency, replacesPurchaseId: replaces };
}

export async function getGiftCardsAdmin(env: TalismanEnv) {
  const db = createDbClient(env);
  return db.select({ id: giftCards.id, codeSuffix: giftCards.codeSuffix,
    source: giftCards.source, purchaseId: giftCards.purchaseId, replacesPurchaseId: giftCards.replacesPurchaseId,
    adminActor: giftCards.adminActor, adminReason: giftCards.adminReason, initialCents: giftCards.initialCents,
    balanceCents: giftCards.balanceCents, currency: giftCards.currency, status: giftCards.status,
    // While its purchase is held for review, the card cannot be reactivated.
    inReview: sql<boolean>`EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases p
      WHERE p.id IN (${giftCards.purchaseId}, ${giftCards.replacesPurchaseId}) AND p.status = 'review')`.mapWith(Boolean),
    createdAt: giftCards.createdAt }).from(giftCards)
    .orderBy(giftCards.createdAt);
}

// A purchase as the review screen shows it: its refunds, the card that holds its value, what was spent
// from its cards on orders (checkouts in progress included), and what checkouts in progress hold.
const reviewSelect = `SELECT p.id AS purchaseId,p.status,p.amount_cents AS amountCents,p.currency,
    p.provider_refunded_cents AS refundedCents,p.refund_adjusted_cents AS adjustedCents,
    c.id AS cardId,c.code_suffix AS codeSuffix,c.status AS cardStatus,c.held_for_review AS cardHeld,
    c.replaces_purchase_id IS NOT NULL AS cardReplacement,c.balance_cents AS balanceCents,
    (SELECT -COALESCE(SUM(l.amount_cents),0) FROM _ecommerce_gift_card_ledger l
      JOIN _ecommerce_gift_cards f ON f.id = l.card_id
      WHERE (f.purchase_id = p.id OR f.replaces_purchase_id = p.id)
        AND l.kind IN ('reserve','release','refund_restore')) AS spentCents,
    (SELECT COALESCE(SUM(r.amount_cents),0) FROM _ecommerce_gift_card_redemptions r
      JOIN _ecommerce_gift_cards f ON f.id = r.card_id
      WHERE (f.purchase_id = p.id OR f.replaces_purchase_id = p.id) AND r.status = 'reserved') AS pendingCents,
    (SELECT COUNT(*) FROM _ecommerce_gift_cards f WHERE f.replaces_purchase_id = p.id) AS replacementCount
  FROM _ecommerce_gift_card_purchases p LEFT JOIN _ecommerce_gift_cards c ON c.id = (${currentCard('p.id')})`;
type ReviewRow = { purchaseId: string; status: string; amountCents: number; currency: string;
  refundedCents: number; adjustedCents: number; cardId: string | null; codeSuffix: string | null;
  cardStatus: 'active' | 'suspended' | null; cardHeld: number | null; cardReplacement: number | null;
  balanceCents: number | null; spentCents: number; pendingCents: number; replacementCount: number };
const reviewView = (row: ReviewRow) => ({ ...row, cardHeld: row.cardHeld === 1, cardReplacement: row.cardReplacement === 1 });

/** Purchases held for review after a provider refund, oldest first, with what is left on their cards. */
export async function getGiftCardReviewsAdmin(env: TalismanEnv) {
  const rows = await env.DB.prepare(`${reviewSelect}
    WHERE p.status = 'review' ORDER BY p.updated_at,p.id LIMIT 100`).all<ReviewRow>();
  const total = await env.DB.prepare(`SELECT COUNT(*) AS count FROM _ecommerce_gift_card_purchases
    WHERE status = 'review'`).first<{ count: number }>();
  return { reviews: (rows.results ?? []).map(reviewView), reviewCount: total?.count ?? 0 };
}

export async function setGiftCardActive(env: TalismanEnv, id: string, active: boolean) {
  if (!/^gift_[0-9a-f-]{36}$/.test(id) || typeof active !== 'boolean') throw new Error('Invalid gift card');
  const db = createDbClient(env);
  const card = await db.select().from(giftCards).where(eq(giftCards.id, id)).get();
  if (!card || card.status === 'void') throw new Error('Gift card is unavailable');
  // Suspending is always possible. A purchased card, or a replacement for one, is reactivated only once
  // its purchase is paid or its refund is resolved. Either choice replaces a review hold, so reinstating
  // the purchase later leaves the card as the administrator set it.
  const timestamp = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(`UPDATE _ecommerce_gift_cards SET status = ?,held_for_review = 0,updated_at = ?
    WHERE id = ? AND status <> 'void' AND (? = 0 OR (
      (purchase_id IS NULL OR EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases p
        WHERE p.id = _ecommerce_gift_cards.purchase_id AND ${settledPurchase}))
      AND (replaces_purchase_id IS NULL OR EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases p
        WHERE p.id = _ecommerce_gift_cards.replaces_purchase_id AND ${settledPurchase}))))
    RETURNING id`).bind(active ? 'active' : 'suspended', timestamp, id, active ? 1 : 0).all();
  if (!result.results?.length) throw new Error('Gift card purchase requires review');
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
  const db = createDbClient(env);
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
  const db = createDbClient(env);
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
  await env.DB.prepare(`INSERT INTO _ecommerce_gift_card_purchases
    (id,buyer_email,amount_cents,currency,status,access_token_hash,created_at,updated_at)
    VALUES (?,?,?,?,'pending',?,?,?)`)
    .bind(id, values.buyerEmail, values.amountCents, currency, await hashGiftCardSecret(accessToken),
      timestamp, timestamp).run();
  let providerSessionId: string | undefined;
  try {
    const session = await adapter.createCheckoutSession({ orderId: id, currency,
      items: [{ name: 'Talisman digital gift card', priceCents: values.amountCents, quantity: 1 }],
      customerEmail: values.buyerEmail,
      metadata: { giftCardPurchaseId: id },
      successUrl: urls.successUrl.replace('{PURCHASE_ID}', id), cancelUrl: urls.cancelUrl });
    providerSessionId = session.providerSessionId;
    await env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases SET provider_session_id = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'`).bind(session.providerSessionId, timestamp, id).run();
    return { id, accessToken, paymentUrl: session.url };
  } catch (error) {
    if (providerSessionId) {
      try { await adapter.expireCheckoutSession?.(providerSessionId); }
      catch {
        await env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases SET provider_session_id = ?
          WHERE id = ? AND status = 'pending'`).bind(providerSessionId, id).run();
        throw error;
      }
    }
    await env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases SET status = 'cancelled', updated_at = ?
      WHERE id = ? AND status = 'pending'`).bind(Math.floor(Date.now() / 1000), id).run();
    throw error;
  }
}

export async function confirmGiftCardPurchase(env: TalismanEnv, session: {
  id: string; metadata?: { giftCardPurchaseId?: string }; client_reference_id?: string;
  amount_total?: number; currency?: string; payment_status?: string; payment_intent?: string;
}) {
  const id = session.metadata?.giftCardPurchaseId;
  if (!id) throw new Error('Gift card purchase ID is missing');
  const db = createDbClient(env);
  const purchase = await db.select().from(giftCardPurchases).where(eq(giftCardPurchases.id, id)).get();
  if (!purchase || purchase.providerSessionId !== session.id ||
    purchase.amountCents !== session.amount_total ||
    session.currency?.toLowerCase() !== purchase.currency.toLowerCase() ||
    session.payment_status !== 'paid' || typeof session.payment_intent !== 'string') {
    throw new Error('Gift card payment does not match purchase');
  }
  if (purchase.status === 'paid') return { success: true, purchaseId: id, duplicate: true };
  if (purchase.status !== 'pending') throw new Error('Gift card purchase is no longer pending');
  const cardId = `gift_${crypto.randomUUID()}`;
  const secret = await newCardSecret(env, cardId);
  const timestamp = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases
      SET status = 'paid',payment_intent_id = ?,updated_at = ?
      WHERE id = ? AND status = 'pending' AND provider_session_id = ?`)
      .bind(session.payment_intent, timestamp, id, session.id),
    env.DB.prepare(`INSERT INTO _ecommerce_gift_cards
      (id,code_hash,code_suffix,encrypted_code,source,purchase_id,initial_cents,balance_cents,currency,status,created_at,updated_at)
      SELECT ?,?,?,?,'purchase',id,amount_cents,0,currency,'active',?,?
      FROM _ecommerce_gift_card_purchases WHERE id = ? AND status = 'paid'
      ON CONFLICT(purchase_id) DO NOTHING`)
      .bind(cardId, secret.codeHash, secret.codeSuffix, secret.encryptedCode, timestamp, timestamp, id),
    env.DB.prepare(`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,purchase_id,kind,amount_cents,created_at)
      SELECT 'gcl_issue_' || id,id,purchase_id,'issue',initial_cents,?
      FROM _ecommerce_gift_cards WHERE purchase_id = ? ON CONFLICT(id) DO NOTHING`)
      .bind(timestamp, id),
  ]);
  return { success: true, purchaseId: id };
}

export async function expireGiftCardPurchase(env: TalismanEnv, id: string, sessionId: string) {
  await env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases SET status = 'cancelled',updated_at = ?
    WHERE id = ? AND provider_session_id = ? AND status = 'pending'`)
    .bind(Math.floor(Date.now() / 1000), id, sessionId).run();
}

/** Repair a paid or expired purchase when its signed webhook did not arrive. */
export async function reconcileGiftCardPurchase(env: TalismanEnv, adapter: PaymentProviderAdapter, id: string) {
  if (adapter.providerId !== 'stripe' || !adapter.getCheckoutSession) {
    throw new Error('Stripe session lookup is required for gift card reconciliation');
  }
  const db = createDbClient(env);
  const purchase = await db.select().from(giftCardPurchases).where(eq(giftCardPurchases.id, id)).get();
  if (!purchase || purchase.status !== 'pending' || !purchase.providerSessionId) return null;
  const session = await adapter.getCheckoutSession(purchase.providerSessionId);
  if (session.status === 'expired') {
    await expireGiftCardPurchase(env, id, purchase.providerSessionId);
    return { status: 'cancelled' };
  }
  if (session.status === 'complete' && session.paymentStatus === 'paid') {
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
  const db = createDbClient(env);
  const purchase = await db.select().from(giftCardPurchases).where(eq(giftCardPurchases.id, id)).get();
  if (!purchase || purchase.accessTokenHash !== await hashGiftCardSecret(accessToken)) return null;
  const card = await db.select().from(giftCards).where(eq(giftCards.purchaseId, id)).get();
  return { status: purchase.status, amountCents: purchase.amountCents,
    // A card whose value moved to a replacement is void, and its code no longer shown.
    code: card && purchase.status === 'paid' && card.status !== 'void'
      ? await decryptCardSecret(await giftCardKeyring(env), card) : null,
    balanceCents: card?.balanceCents ?? null };
}

/**
 * Statements that apply a purchase's review hold to every card it funds: the purchased card and the
 * replacements that took over its value. While the purchase is held for review, none of them can be
 * spent; the hold marks the cards it suspends, so reinstating the purchase reactivates only those. A
 * fully refunded purchase whose cards were never spent on an order is settled at once: what is left on
 * them is reversed and they are voided. A purchase with no card left to hold leaves review as refunded
 * or partially refunded. Add them to the batch that moves the purchase to 'review'.
 */
export function giftCardPurchaseHoldStatements(env: TalismanEnv, purchaseId: string, timestamp: number) {
  // Reversals of earlier refunds and moves to a replacement are not spending; orders are, including a
  // checkout in progress (its reservation is in the ledger until released).
  const unspentFullRefund = `EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases p
    WHERE p.id = ? AND p.status = 'review' AND p.provider_refunded_cents >= p.amount_cents
      AND NOT ${pendingCheckout('p.id')}
      AND (SELECT COALESCE(SUM(l.amount_cents),0) FROM _ecommerce_gift_card_ledger l
        JOIN _ecommerce_gift_cards f ON f.id = l.card_id
        WHERE (f.purchase_id = p.id OR f.replaces_purchase_id = p.id)
          AND l.kind IN ('reserve','release','refund_restore')) = 0)`;
  return [
    env.DB.prepare(`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,purchase_id,kind,amount_cents,created_at)
      SELECT 'gcl_purchase_reversal_' || c.id,c.id,?,'purchase_reversal',-c.balance_cents,?
      FROM _ecommerce_gift_cards c WHERE (c.purchase_id = ? OR c.replaces_purchase_id = ?)
        AND c.status <> 'void' AND c.balance_cents > 0 AND ${unspentFullRefund}
      ON CONFLICT(id) DO NOTHING`)
      .bind(purchaseId, timestamp, purchaseId, purchaseId, purchaseId),
    env.DB.prepare(`UPDATE _ecommerce_gift_cards SET status = 'void',held_for_review = 0,updated_at = ?
      WHERE (purchase_id = ? OR replaces_purchase_id = ?) AND status <> 'void' AND ${unspentFullRefund}`)
      .bind(timestamp, purchaseId, purchaseId, purchaseId),
    env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases
      SET status = CASE WHEN provider_refunded_cents >= amount_cents THEN 'refunded' ELSE 'partially_refunded' END,
        refund_adjusted_cents = provider_refunded_cents,updated_at = ?
      WHERE id = ? AND status = 'review' AND NOT EXISTS (SELECT 1 FROM _ecommerce_gift_cards c
        WHERE (c.purchase_id = ? OR c.replaces_purchase_id = ?) AND c.status <> 'void')`)
      .bind(timestamp, purchaseId, purchaseId, purchaseId),
    env.DB.prepare(`UPDATE _ecommerce_gift_cards SET status = 'suspended',held_for_review = 1,updated_at = ?
      WHERE (purchase_id = ? OR replaces_purchase_id = ?) AND status = 'active'
        AND EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases p WHERE p.id = ? AND p.status = 'review')`)
      .bind(timestamp, purchaseId, purchaseId, purchaseId),
  ];
}

export async function recordGiftCardPurchaseRefund(env: TalismanEnv, params: {
  paymentIntentId: string; amount: number; amountRefunded: number; currency: string;
}) {
  const db = createDbClient(env);
  const purchase = await db.select().from(giftCardPurchases)
    .where(eq(giftCardPurchases.paymentIntentId, params.paymentIntentId)).get();
  if (!purchase) return null;
  if (purchase.amountCents !== params.amount ||
    params.currency.toLowerCase() !== purchase.currency.toLowerCase() ||
    !Number.isSafeInteger(params.amountRefunded) || params.amountRefunded < 0 ||
    params.amountRefunded > purchase.amountCents) throw new Error('Gift card refund does not match purchase');
  if (params.amountRefunded <= purchase.providerRefundedCents) return { success: true, duplicate: true };
  const timestamp = Math.floor(Date.now() / 1000);
  // Each new refund total holds the purchase for review, including one already resolved. The hold
  // statements work from the stored state, so a stale or repeated event only reapplies it.
  await env.DB.batch([
    env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases SET status = 'review',provider_refunded_cents = ?,updated_at = ?
      WHERE id = ? AND provider_refunded_cents < ?`)
      .bind(params.amountRefunded, timestamp, purchase.id, params.amountRefunded),
    ...giftCardPurchaseHoldStatements(env, purchase.id, timestamp),
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
  const purchase = await env.DB.prepare(`${reviewSelect} WHERE p.id = ?`).bind(values.purchaseId).first<ReviewRow>();
  if (purchase?.status !== 'review') throw new Error('Gift card purchase is not held for review');
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
  const held = `EXISTS (SELECT 1 FROM _ecommerce_gift_card_purchases
    WHERE id = ? AND status = 'review' AND provider_refunded_cents = ?)`;
  const recorded = `EXISTS (SELECT 1 FROM _ecommerce_gift_card_reviews WHERE id = ?)`;
  const guard = [values.purchaseId, values.refundedCents, reviewId] as const;
  const funded = [values.purchaseId, values.purchaseId] as const;
  const statements = values.outcome === 'reinstate' ? [
    // Recorded only while the card that holds the purchase's value covers the refund not yet taken off.
    env.DB.prepare(`INSERT INTO _ecommerce_gift_card_reviews
      (id,purchase_id,card_id,outcome,refunded_cents,adjustment_cents,admin_actor,reason,created_at)
      SELECT ?,p.id,c.id,'reinstate',p.provider_refunded_cents,p.provider_refunded_cents - p.refund_adjusted_cents,?,?,?
      FROM _ecommerce_gift_card_purchases p JOIN _ecommerce_gift_cards c ON c.id = (${currentCard('p.id')})
      WHERE p.id = ? AND p.status = 'review' AND p.provider_refunded_cents = ?
        AND c.balance_cents >= p.provider_refunded_cents - p.refund_adjusted_cents
      RETURNING adjustment_cents`)
      .bind(reviewId, actor, values.reason, timestamp, values.purchaseId, values.refundedCents),
    env.DB.prepare(`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,purchase_id,kind,amount_cents,created_at)
      SELECT 'gcl_' || r.id,r.card_id,r.purchase_id,'purchase_reversal',-r.adjustment_cents,r.created_at
      FROM _ecommerce_gift_card_reviews r WHERE r.id = ? AND r.adjustment_cents > 0 AND ${held}`)
      .bind(reviewId, values.purchaseId, values.refundedCents),
    env.DB.prepare(`UPDATE _ecommerce_gift_cards SET status = 'active',held_for_review = 0,updated_at = ?
      WHERE (purchase_id = ? OR replaces_purchase_id = ?) AND status = 'suspended' AND held_for_review = 1
        AND ${held} AND ${recorded}`)
      .bind(timestamp, ...funded, ...guard),
  ] : [
    // Recorded only while no checkout in progress holds value on the purchase's cards, so nothing is
    // released onto them once they are void.
    env.DB.prepare(`INSERT INTO _ecommerce_gift_card_reviews
      (id,purchase_id,card_id,outcome,refunded_cents,adjustment_cents,admin_actor,reason,created_at)
      SELECT ?,p.id,COALESCE((${currentCard('p.id')}),
          (SELECT o.id FROM _ecommerce_gift_cards o WHERE o.purchase_id = p.id)),
        'void',p.provider_refunded_cents,${cardValue('p.id')},?,?,?
      FROM _ecommerce_gift_card_purchases p
      WHERE p.id = ? AND p.status = 'review' AND p.provider_refunded_cents = ? AND NOT ${pendingCheckout('p.id')}
      RETURNING adjustment_cents`)
      .bind(reviewId, actor, values.reason, timestamp, values.purchaseId, values.refundedCents),
    env.DB.prepare(`INSERT INTO _ecommerce_gift_card_ledger
      (id,card_id,purchase_id,kind,amount_cents,created_at)
      SELECT ? || '_' || id,id,?,'purchase_reversal',-balance_cents,?
      FROM _ecommerce_gift_cards WHERE (purchase_id = ? OR replaces_purchase_id = ?) AND status <> 'void'
        AND balance_cents > 0 AND ${held} AND ${recorded}`)
      .bind(`gcl_${reviewId}`, values.purchaseId, timestamp, ...funded, ...guard),
    env.DB.prepare(`UPDATE _ecommerce_gift_cards SET status = 'void',held_for_review = 0,updated_at = ?
      WHERE (purchase_id = ? OR replaces_purchase_id = ?) AND status <> 'void' AND ${held} AND ${recorded}`)
      .bind(timestamp, ...funded, ...guard),
  ];
  statements.push(env.DB.prepare(`UPDATE _ecommerce_gift_card_purchases
    SET status = CASE WHEN provider_refunded_cents >= amount_cents THEN 'refunded' ELSE 'partially_refunded' END,
      refund_adjusted_cents = provider_refunded_cents,updated_at = ?
    WHERE id = ? AND status = 'review' AND provider_refunded_cents = ? AND ${recorded}`)
    .bind(timestamp, values.purchaseId, values.refundedCents, reviewId));
  const [review] = await env.DB.batch<{ adjustment_cents: number }>(statements);
  const adjustment = review.results?.[0];
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
  const row = await env.DB.prepare(`SELECT id,gift_card_id,gift_card_applied,gift_card_refunded_cents,status,referral_code
    FROM _ecommerce_orders WHERE id = ?`).bind(values.orderId).all();
  const current = row.results?.[0] as { gift_card_id: string | null; gift_card_applied: number;
    gift_card_refunded_cents: number; status: string; referral_code: string | null } | undefined;
  if (!current?.gift_card_id || !['paid', 'fulfilled', 'partially_refunded'].includes(current.status)) {
    throw new Error('Order is unavailable for a gift card refund');
  }
  const remaining = current.gift_card_applied - current.gift_card_refunded_cents;
  if (!values.amountCents || values.amountCents > remaining) throw new Error('Refund exceeds gift card payment');
  const id = `gfr_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  const statements: D1PreparedStatement[] = [env.DB.prepare(`INSERT INTO _ecommerce_gift_card_refunds
    (id,card_id,order_id,amount_cents,admin_actor,reason,created_at)
    VALUES (?,?,?,?,?,?,?)`)
    .bind(id, current.gift_card_id, values.orderId, values.amountCents, actor, values.reason, now)];
  // A refund that leaves less than the referral minimum paid voids the referral and reverses released awards.
  if (current.referral_code) {
    const policy = await getReferralPolicy(env);
    statements.push(...referralReversalStatements(env, values.orderId, { minOrderCents: policy.minOrderCents, now }));
  }
  await env.DB.batch(statements);
  return { id, orderId: values.orderId, amountCents: values.amountCents };
}

/** Refund a zero-provider gift-card order, including any promotional credit used with it. */
export async function refundGiftCardOnlyOrder(env: TalismanEnv, actor: string, input: unknown) {
  const values = refundSchema.parse(input);
  if (!actor.trim() || values.amountCents !== undefined) throw new Error('Invalid full refund request');
  const row = await env.DB.prepare(`SELECT id,gift_card_id,gift_card_applied,gift_card_refunded_cents,
    credit_applied,payment_provider,total_amount,status,user_id FROM _ecommerce_orders WHERE id = ?`)
    .bind(values.orderId).all();
  const order = row.results?.[0] as { id: string; gift_card_id: string; gift_card_applied: number;
    gift_card_refunded_cents: number; credit_applied: number; payment_provider: string;
    total_amount: number; status: string; user_id: string | null } | undefined;
  if (!order || order.payment_provider !== 'gift_card' || order.total_amount !== 0 ||
    !['paid', 'partially_refunded', 'fulfilled'].includes(order.status)) {
    throw new Error('Only paid gift-card-only orders can be refunded here');
  }
  const now = Math.floor(Date.now() / 1000);
  const remaining = order.gift_card_applied - order.gift_card_refunded_cents;
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`INSERT INTO _ecommerce_gift_card_order_refunds
      (order_id,admin_actor,reason,created_at) VALUES (?,?,?,?)`)
      .bind(order.id, actor, values.reason, now),
  ];
  if (remaining > 0) statements.push(env.DB.prepare(`INSERT INTO _ecommerce_gift_card_refunds
    (id,card_id,order_id,amount_cents,admin_actor,reason,created_at)
    VALUES (?,?,?,?,?,?,?)`)
    .bind(`gfr_full_${order.id}`, order.gift_card_id, order.id, remaining, actor, values.reason, now));
  statements.push(env.DB.prepare(`UPDATE _ecommerce_orders SET status = 'refunded',updated_at = ?
    WHERE id = ? AND payment_provider = 'gift_card' AND total_amount = 0
      AND status IN ('paid','fulfilled','partially_refunded')`).bind(now, order.id));
  statements.push(env.DB.prepare(`UPDATE _ecommerce_gift_card_redemptions SET status = 'refunded',updated_at = ?
    WHERE order_id = ? AND status = 'confirmed'`).bind(now, order.id));
  statements.push(env.DB.prepare(`UPDATE _ecommerce_discount_redemptions SET status = 'refunded',updated_at = ?
    WHERE order_id = ? AND status = 'confirmed'`).bind(now, order.id));
  if (order.credit_applied > 0 && order.user_id) statements.push(env.DB.prepare(`INSERT INTO _ecommerce_credit_ledger
    (id,account_id,order_id,kind,amount_cents,created_at)
    VALUES (?, ?, ?, 'purchase_credit_refund', ?, ?) ON CONFLICT(order_id,kind) DO NOTHING`)
    .bind(`credit_refund_${order.id}`, order.user_id, order.id, order.credit_applied, now));
  statements.push(env.DB.prepare(`UPDATE _ecommerce_payments SET status = 'refunded' WHERE order_id = ?`)
    .bind(order.id));
  await env.DB.batch(statements);
  return { orderId: order.id, status: 'refunded' };
}
