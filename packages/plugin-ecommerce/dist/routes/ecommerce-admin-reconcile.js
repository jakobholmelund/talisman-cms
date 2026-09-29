import {
  runtimePaymentAdapters
} from "../chunk-DQ2SJLJ6.js";
import "../chunk-6L7TQXAW.js";
import {
  bindCommerceApi,
  reconcileCommerce
} from "../chunk-3F4TX7AS.js";
import "../chunk-TT3MVFMZ.js";
import "../chunk-NOGKXEVT.js";
import "../chunk-BGDJXEM5.js";
import "../chunk-FFJXPA3V.js";
import {
  RECONCILE_FAILURE_MESSAGES,
  RECONCILE_TABLES,
  completedCheckoutReturn,
  decisionInsert,
  isMissingSessionError,
  isOtherStripeModeSession,
  isProviderError,
  reconcileFailure,
  uncheckedSessionRefusal
} from "../chunk-4LBJN5LU.js";
import "../chunk-NTFJG6BA.js";
import {
  runtimeStripeMode,
  stripeSessionMode
} from "../chunk-GNU6N22K.js";
import "../chunk-IAWGIRUS.js";
import {
  commerceDb
} from "../chunk-ZI5IJOR6.js";
import {
  giftCardPurchases,
  orders,
  reconcileDecisions
} from "../chunk-NKJTK7MK.js";
import "../chunk-NMGICNSV.js";
import "../chunk-2UYSCNNW.js";

// src/routes/ecommerce-admin-reconcile.ts
import { authorizeCmsRequest } from "talisman-cms/auth/guard";

// src/reconcile-review.ts
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
var ReconcileInputError = class extends Error {
  name = "ReconcileInputError";
};
var PARKED_LIST_LIMIT = 100;
var PROVIDER_UNREACHABLE = "Stripe could not be asked about this checkout session, so nothing was released. Try again later.";
var retrySchema = z.object({
  kind: z.enum(["order", "gift_card_purchase"]),
  id: z.string().trim().min(1).max(128),
  // Counted in characters, as the decision table's CHECK counts them; String.length counts UTF-16 units.
  reason: z.string().trim().refine((reason) => [...reason].length >= 8 && [...reason].length <= 500)
}).strict();
var releaseSchema = retrySchema.extend({ confirmPaymentReturned: z.boolean().optional() }).strict();
function parseAction(schema, input) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ReconcileInputError("Name the parked record (kind order or gift_card_purchase, and its id) and give a reason of 8 to 500 characters");
  }
  return parsed.data;
}
function newDecision(actor, reason) {
  if (!actor.trim()) throw new Error("Administrator identity is required");
  return { id: `rcd_${crypto.randomUUID()}`, actor, reason };
}
var parked = (table) => sql`${table.status} = 'pending' AND ${table.reconcileReviewAt} IS NOT NULL`;
var at = (seconds) => new Date(seconds * 1e3);
var recorded = (decisionId) => sql`EXISTS (SELECT 1 FROM _ecommerce_reconcile_decisions WHERE id = ${decisionId})`;
var notParked = (kind) => kind === "order" ? "This order is not pending and parked for review; reload the list" : "This gift card purchase is not pending and parked for review; reload the list";
var isoTime = (seconds) => new Date(seconds * 1e3).toISOString();
async function listParkedCommerce(env) {
  const db = commerceDb(env);
  const [rows, counted] = await db.batch([
    db.all(sql`SELECT 'order' AS kind, id, created_at, reconcile_attempts AS attempts,
        reconcile_last_at AS last_at, reconcile_last_error AS last_error, reconcile_review_at AS review_at,
        checkout_session_id AS session_id, COALESCE(payment_provider, 'stripe') AS provider,
        total_amount AS amount_cents, currency
      FROM _ecommerce_orders WHERE ${parked(orders)}
      UNION ALL
      SELECT 'gift_card_purchase', id, created_at, reconcile_attempts, reconcile_last_at, reconcile_last_error,
        reconcile_review_at, provider_session_id, 'stripe', amount_cents, currency
      FROM _ecommerce_gift_card_purchases WHERE ${parked(giftCardPurchases)}
      ORDER BY review_at, id LIMIT ${PARKED_LIST_LIMIT}`),
    db.get(sql`SELECT (SELECT COUNT(*) FROM _ecommerce_orders WHERE ${parked(orders)})
      + (SELECT COUNT(*) FROM _ecommerce_gift_card_purchases WHERE ${parked(giftCardPurchases)}) AS count`)
  ]);
  const storeMode = runtimeStripeMode(env);
  return {
    storeMode,
    parkedCount: Number(counted?.count ?? 0),
    parked: rows.map((row) => {
      const code = row.last_error && row.last_error in RECONCILE_FAILURE_MESSAGES ? row.last_error : "failed";
      const stripe = row.provider === "stripe";
      return {
        kind: row.kind,
        id: row.id,
        createdAt: isoTime(row.created_at),
        parkedAt: isoTime(row.review_at),
        lastAttemptAt: row.last_at === null ? null : isoTime(row.last_at),
        attempts: row.attempts,
        lastError: code,
        problem: RECONCILE_FAILURE_MESSAGES[code],
        provider: row.provider,
        sessionMode: stripe ? stripeSessionMode(row.session_id) : null,
        otherMode: stripe && isOtherStripeModeSession(env, row.session_id),
        amountCents: row.amount_cents,
        currency: row.currency
      };
    })
  };
}
async function retryParkedCommerce(env, actor, input) {
  const { kind, id, reason } = parseAction(retrySchema, input);
  const decision = newDecision(actor, reason);
  const timestamp = Math.floor(Date.now() / 1e3);
  const db = commerceDb(env);
  const table = RECONCILE_TABLES[kind];
  const [, retried] = await db.batch([
    db.run(decisionInsert(kind, "retry", parked(table), {
      id: decision.id,
      paymentReturned: null,
      actor: decision.actor,
      reason: decision.reason,
      at: timestamp,
      recordId: id
    })),
    db.update(table).set({ reconcileReviewAt: null, reconcileAttempts: 0, reconcileLastAt: null, reconcileLastError: null }).where(and(eq(table.id, id), parked(table), recorded(decision.id))).returning({ id: table.id })
  ]);
  if (!retried.length) throw new Error(notParked(kind));
  console.info("[commerce] Parked checkout returned to reconciliation", { kind, id, actor });
  return { kind, id, status: "pending" };
}
function releaseRefusal(error) {
  const failure = reconcileFailure(error);
  if (failure.code === "provider_unavailable" || failure.code === "provider_refused") {
    return new Error(PROVIDER_UNREACHABLE, { cause: error });
  }
  return isProviderError(error) ? new Error("Stripe returned an error about this checkout session, so nothing was released.", { cause: error }) : error;
}
async function releaseParkedCommerce(options, actor, input) {
  const { kind, id, reason, confirmPaymentReturned = false } = parseAction(releaseSchema, input);
  const decision = newDecision(actor, reason);
  const { env } = options;
  const db = commerceDb(env);
  const table = RECONCILE_TABLES[kind];
  const row = await db.select({
    sessionId: kind === "order" ? orders.checkoutSessionId : giftCardPurchases.providerSessionId,
    createdAt: table.createdAt
  }).from(table).where(and(eq(table.id, id), parked(table))).get();
  if (!row) throw new Error(notParked(kind));
  const otherMode = isOtherStripeModeSession(env, row.sessionId);
  const decided = () => db.select({ paymentReturned: reconcileDecisions.paymentReturned }).from(reconcileDecisions).where(eq(reconcileDecisions.id, decision.id)).get();
  let paymentReturned = null;
  if (kind === "order") {
    try {
      await bindCommerceApi(options).orders.cancel(id, { reviewRelease: { decision, confirmPaymentReturned } });
    } catch (error) {
      throw releaseRefusal(error);
    }
    const outcome = await decided();
    if (!outcome) throw new Error("The order changed while it was being released; reload the list");
    paymentReturned = outcome.paymentReturned;
  } else {
    if (row.sessionId) {
      const stripe = options.paymentAdapters?.find((adapter) => adapter.providerId === "stripe");
      if (!stripe?.getCheckoutSession || !stripe.expireCheckoutSession) {
        throw new Error("Stripe must be configured to check this checkout session before the purchase is released");
      }
      const refuseUnchecked = () => {
        const refusal = uncheckedSessionRefusal(Math.floor(row.createdAt.getTime() / 1e3));
        if (refusal) throw refusal;
      };
      if (otherMode) refuseUnchecked();
      if (!otherMode) {
        try {
          let session = null;
          try {
            session = await stripe.getCheckoutSession(row.sessionId);
          } catch (error) {
            if (!isMissingSessionError(error)) throw error;
            refuseUnchecked();
          }
          if (session?.status === "complete") paymentReturned = await completedCheckoutReturn(stripe, session, confirmPaymentReturned);
          else if (session && session.status !== "expired") await stripe.expireCheckoutSession(row.sessionId);
        } catch (error) {
          throw releaseRefusal(error);
        }
      }
    }
    const timestamp = Math.floor(Date.now() / 1e3);
    const [, released] = await db.batch([
      db.run(decisionInsert(kind, "release", parked(table), {
        id: decision.id,
        paymentReturned,
        actor: decision.actor,
        reason: decision.reason,
        at: timestamp,
        recordId: id
      })),
      db.update(giftCardPurchases).set({ status: "cancelled", updatedAt: at(timestamp) }).where(and(eq(giftCardPurchases.id, id), parked(giftCardPurchases), recorded(decision.id))).returning({ id: giftCardPurchases.id })
    ]);
    if (!released.length) throw new Error("The purchase changed while it was being released; reload the list");
  }
  console.info("[commerce] Parked checkout released", { kind, id, actor, otherMode });
  return { kind, id, status: "cancelled", otherMode, paymentReturned };
}

// src/routes/ecommerce-admin-reconcile.ts
var ALL = async ({ request }) => {
  const authorization = await authorizeCmsRequest(request, "admin");
  if (authorization.response) return authorization.response;
  const headers = { "Cache-Control": "no-store" };
  if (request.method !== "GET" && request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers });
  }
  if (request.method === "POST" && request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ error: "Same-origin request required" }, { status: 403, headers });
  }
  let action;
  try {
    const { env } = await import("cloudflare:workers");
    const runtimeEnv = env;
    if (request.method === "GET") return Response.json(await listParkedCommerce(runtimeEnv), { headers });
    const text = await request.text();
    const body = text.trim() ? JSON.parse(text) : {};
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "Invalid reconciliation action" }, { status: 400, headers });
    }
    const { action: requested, ...input } = body;
    action = requested;
    const paymentAdapters = runtimePaymentAdapters(runtimeEnv);
    if (action === void 0) {
      const results = await reconcileCommerce({ env: runtimeEnv, paymentAdapters });
      return Response.json({ results }, { headers });
    }
    const actor = String(authorization.user?.id ?? "");
    let result;
    if (action === "retry") result = await retryParkedCommerce(runtimeEnv, actor, input);
    else if (action === "release") result = await releaseParkedCommerce({ env: runtimeEnv, paymentAdapters }, actor, input);
    else return Response.json({ error: "Invalid reconciliation action" }, { status: 400, headers });
    return Response.json({ result }, { headers });
  } catch (error) {
    const invalid = error instanceof ReconcileInputError || error instanceof SyntaxError;
    const fallback = request.method === "GET" ? "Parked records could not be listed" : "Reconciliation failed";
    return Response.json(
      { error: error instanceof Error ? error.message : fallback },
      { status: invalid ? 400 : request.method === "GET" || action === void 0 ? 500 : 409, headers }
    );
  }
};
export {
  ALL
};
