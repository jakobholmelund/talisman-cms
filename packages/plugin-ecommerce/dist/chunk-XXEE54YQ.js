import {
  GiftCardRefusal,
  readStoreSettings
} from "./chunk-K7KINC5L.js";
import {
  referralPolicyFromSaved,
  referralTermsError
} from "./chunk-OSTMSMQZ.js";
import {
  hasPurchaseHistory
} from "./chunk-JHEPRJVB.js";
import {
  commerceDb,
  commitBatch
} from "./chunk-HZZSX5TT.js";
import {
  customerAccounts,
  discountCodeCreations,
  discountCodes,
  discountRedemptions,
  referralCodes,
  referralSettings
} from "./chunk-3XLIJPB2.js";
import {
  minimumChargeAmount
} from "./chunk-2UYSCNNW.js";

// src/promotions.ts
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
var optionalLimit = z.number().int().positive().max(1e6).nullable();
var optionalDate = z.number().int().positive().nullable();
var discountCodeSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{2,31}$/),
  description: z.string().trim().max(200).nullable(),
  type: z.enum(["credit", "amount", "percent"]),
  value: z.number().int().positive().max(1e6),
  maxDiscountCents: optionalLimit,
  minOrderCents: z.number().int().min(0).max(1e7),
  eligibleProductIds: z.array(z.string().trim().min(1).max(128)).max(100),
  maxUses: optionalLimit,
  maxUsesPerCustomer: optionalLimit,
  firstOrderOnly: z.boolean(),
  startsAt: optionalDate,
  expiresAt: optionalDate,
  active: z.boolean()
}).strict().superRefine((value, ctx) => {
  if (value.type === "percent" && value.value > 1e4) {
    ctx.addIssue({ code: "custom", path: ["value"], message: "Percent must be at most 100%" });
  }
  if (value.type === "credit" && !/^GC-[A-F0-9]{24}$/.test(value.code)) {
    ctx.addIssue({ code: "custom", path: ["code"], message: "Credit voucher codes must be generated securely" });
  }
  if (value.type !== "percent" && value.maxDiscountCents !== null) {
    ctx.addIssue({ code: "custom", path: ["maxDiscountCents"], message: "Only percent codes support a cap" });
  }
  if (value.startsAt && value.expiresAt && value.expiresAt <= value.startsAt) {
    ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Expiry must follow the start date" });
  }
  if (new Set(value.eligibleProductIds).size !== value.eligibleProductIds.length) {
    ctx.addIssue({ code: "custom", path: ["eligibleProductIds"], message: "Product IDs must be unique" });
  }
});
var referralSettingsSchema = z.object({
  enabled: z.boolean(),
  rewardCents: z.number().int().min(1).max(1e5),
  minOrderCents: z.number().int().min(1).max(1e7),
  attributionDays: z.number().int().min(1).max(90)
}).strict().superRefine((value, ctx) => {
  const termsError = value.enabled ? referralTermsError(value) : null;
  if (termsError) ctx.addIssue({ code: "custom", path: ["rewardCents"], message: termsError });
});
function discountAmountForLines(code, lines, subtotal, currency) {
  if (!Number.isSafeInteger(subtotal) || subtotal < code.minOrderCents) return 0;
  const eligible = code.eligibleProductIds.length ? lines.filter((line) => code.eligibleProductIds.includes(line.productId)) : lines;
  const eligibleSubtotal = eligible.reduce((sum, line) => sum + line.priceAtPurchase * line.quantity, 0);
  if (!Number.isSafeInteger(eligibleSubtotal) || eligibleSubtotal <= 0) return 0;
  const raw = code.type === "percent" ? Number(BigInt(eligibleSubtotal) * BigInt(code.value) / 10000n) : code.type === "credit" ? Math.min(code.remainingCents ?? 0, eligibleSubtotal) : Math.min(code.value, eligibleSubtotal);
  const capped = code.type === "percent" && code.maxDiscountCents !== null ? Math.min(raw, code.maxDiscountCents) : raw;
  return Math.max(0, Math.min(capped, subtotal - minimumChargeAmount(currency)));
}
var DiscountCodeRefusal = class extends Error {
  reason;
  constructor(reason, message) {
    super(message);
    this.name = "DiscountCodeRefusal";
    this.reason = reason;
  }
};
var CODE_REFUSAL_MESSAGE = "This code is not valid for this order.";
function codeRefusalBody(error) {
  if (error instanceof DiscountCodeRefusal) return { error: CODE_REFUSAL_MESSAGE, field: "code" };
  if (error instanceof GiftCardRefusal) return { error: CODE_REFUSAL_MESSAGE, field: "giftCardCode" };
  const message = error instanceof Error ? error.message : "";
  if (message === "Discount code is no longer available") return { error: CODE_REFUSAL_MESSAGE, field: "code" };
  if (message === "Gift card is no longer available") return { error: CODE_REFUSAL_MESSAGE, field: "giftCardCode" };
  return null;
}
async function evaluateDiscountCode(env, input) {
  const { currency } = readStoreSettings(env);
  const normalizedCode = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(normalizedCode)) throw new DiscountCodeRefusal("format", "Invalid discount code");
  const db = commerceDb(env);
  const code = await db.select().from(discountCodes).where(eq(discountCodes.code, normalizedCode)).get();
  if (!code) throw new DiscountCodeRefusal("unknown", "Discount code is unavailable");
  if (!code.active) throw new DiscountCodeRefusal("inactive", "Discount code is unavailable");
  const now = Date.now();
  if (code.startsAt && code.startsAt.getTime() > now || code.expiresAt && code.expiresAt.getTime() <= now) {
    throw new DiscountCodeRefusal("dates", "Discount code is outside its active dates");
  }
  const account = input.accountId ? await db.select().from(customerAccounts).where(eq(customerAccounts.id, input.accountId)).get() : null;
  const emailNormalized = account?.emailNormalized ?? input.customerEmail.trim().toLowerCase();
  const checkShopper = input.checkShopperHistory !== false;
  if (checkShopper && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNormalized)) {
    throw new DiscountCodeRefusal("email_required", "Valid email required for a discount");
  }
  if (checkShopper && code.firstOrderOnly && await hasPurchaseHistory(env, { emails: [emailNormalized], accountIds: [account?.id] })) {
    throw new DiscountCodeRefusal("first_order", "Discount is for a first purchase only");
  }
  if (code.maxUses !== null) {
    const [{ uses }] = await db.select({ uses: count() }).from(discountRedemptions).where(and(
      eq(discountRedemptions.code, code.code),
      inArray(discountRedemptions.status, ["reserved", "confirmed"])
    ));
    if (uses >= code.maxUses) throw new DiscountCodeRefusal("use_limit", "Discount code has reached its use limit");
  }
  if (checkShopper && code.maxUsesPerCustomer !== null) {
    const [{ uses }] = await db.select({ uses: count() }).from(discountRedemptions).where(and(
      eq(discountRedemptions.code, code.code),
      eq(discountRedemptions.emailNormalized, emailNormalized),
      inArray(discountRedemptions.status, ["reserved", "confirmed"])
    ));
    if (uses >= code.maxUsesPerCustomer) {
      throw new DiscountCodeRefusal("customer_limit", "Discount code was already used by this shopper");
    }
  }
  const amount = discountAmountForLines(code, input.lines, input.subtotal, currency);
  if (!amount) throw new DiscountCodeRefusal("not_applicable", "Discount code does not apply to this basket");
  return { code: code.code, type: code.type, amount, emailNormalized, eligibleProductIds: code.eligibleProductIds };
}
async function getPromotionsAdmin(env) {
  const db = commerceDb(env);
  const codes = await db.select().from(discountCodes).orderBy(discountCodes.createdAt);
  const usage = await db.select({
    code: discountRedemptions.code,
    status: discountRedemptions.status,
    uses: count()
  }).from(discountRedemptions).groupBy(discountRedemptions.code, discountRedemptions.status);
  const referralLinks = await db.select({
    code: referralCodes.code,
    active: referralCodes.active,
    email: customerAccounts.email
  }).from(referralCodes).innerJoin(customerAccounts, eq(referralCodes.accountId, customerAccounts.id));
  const saved = await db.select().from(referralSettings).where(eq(referralSettings.id, "default")).get();
  return {
    referral: referralPolicyFromSaved(env, saved),
    referralRevision: saved ? Math.floor(saved.updatedAt.getTime() / 1e3) : null,
    referralLinks,
    codes,
    usage
  };
}
async function setReferralCodeActive(env, code, active) {
  if (!/^REF-[A-F0-9]{20}$/.test(code) || typeof active !== "boolean") {
    throw new Error("Invalid referral code status");
  }
  const db = commerceDb(env);
  const changed = await db.update(referralCodes).set({ active }).where(eq(referralCodes.code, code)).returning({ code: referralCodes.code });
  if (!changed.length) throw new Error("Referral code not found");
  return { code, active };
}
var PromotionConflictError = class extends Error {
  name = "PromotionConflictError";
  constructor() {
    super("These settings changed since you loaded them. Load the latest version before saving.");
  }
};
function versionedInput(input) {
  const raw = input && typeof input === "object" ? input : {};
  const { expectedVersion, ...fields } = raw;
  if (expectedVersion !== void 0) z.number().int().nonnegative().nullable().parse(expectedVersion);
  return { fields, expectedVersion };
}
async function saveReferralSettings(env, input) {
  const { fields, expectedVersion } = versionedInput(input);
  const parsed = referralSettingsSchema.safeParse(fields);
  if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
  const values = parsed.data;
  const db = commerceDb(env);
  const now = Math.floor(Date.now() / 1e3);
  const changed = expectedVersion === null ? await db.insert(referralSettings).values({ id: "default", ...values, updatedAt: new Date(now * 1e3) }).onConflictDoNothing().returning() : expectedVersion !== void 0 ? await db.update(referralSettings).set({ ...values, updatedAt: sql`MAX(${referralSettings.updatedAt} + 1, ${now})` }).where(and(eq(referralSettings.id, "default"), eq(referralSettings.updatedAt, new Date(expectedVersion * 1e3)))).returning() : await db.insert(referralSettings).values({ id: "default", ...values, updatedAt: new Date(now * 1e3) }).onConflictDoUpdate({
    target: referralSettings.id,
    set: { ...values, updatedAt: sql`MAX(${referralSettings.updatedAt} + 1, ${now})` }
  }).returning();
  if (!changed.length) throw new PromotionConflictError();
  return referralPolicyFromSaved(env, changed[0]);
}
var creationKeySchema = z.string().uuid().transform((value) => value.toLowerCase());
var creationActorSchema = z.string().trim().min(1).max(128);
async function creationHash(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function createDiscountCode(env, input, actor) {
  const raw = input && typeof input === "object" ? input : {};
  const { requestKey: rawKey, ...fields } = raw;
  const requestKey = rawKey === void 0 ? null : creationKeySchema.parse(rawKey);
  const values = discountCodeSchema.parse({ ...fields, code: raw.type === "credit" ? `GC-${"0".repeat(24)}` : raw.code });
  const db = commerceDb(env);
  const creation = requestKey ? {
    id: await creationHash(`promotion-create:${requestKey}`),
    actor: creationActorSchema.parse(actor),
    fingerprint: await creationHash(JSON.stringify({ ...values, code: values.type === "credit" ? null : values.code }))
  } : null;
  async function recover() {
    if (!creation) return null;
    const previous2 = await db.select().from(discountCodeCreations).where(eq(discountCodeCreations.id, creation.id)).get();
    if (!previous2) return null;
    if (previous2.actor !== creation.actor || previous2.fingerprint !== creation.fingerprint) {
      throw new Error("This creation retry belongs to different promotion details or another administrator");
    }
    const code = await db.select().from(discountCodes).where(eq(discountCodes.code, previous2.code)).get();
    if (!code) throw new Error("The created promotion is unavailable; review the existing codes");
    return code;
  }
  const previous = await recover();
  if (previous) return previous;
  if (values.type === "credit") {
    values.code = `GC-${Array.from(
      crypto.getRandomValues(new Uint8Array(12)),
      (byte) => byte.toString(16).padStart(2, "0")
    ).join("").toUpperCase()}`;
  }
  const now = /* @__PURE__ */ new Date();
  const insert = db.insert(discountCodes).values({
    ...values,
    remainingCents: values.type === "credit" ? values.value : null,
    startsAt: values.startsAt ? new Date(values.startsAt * 1e3) : null,
    expiresAt: values.expiresAt ? new Date(values.expiresAt * 1e3) : null,
    createdAt: now,
    updatedAt: now
  });
  try {
    if (creation) await commitBatch(db, [
      insert,
      db.insert(discountCodeCreations).values({ ...creation, code: values.code, createdAt: now })
    ]);
    else await insert;
  } catch (cause) {
    const winner = await recover();
    if (winner) return winner;
    throw cause;
  }
  return db.select().from(discountCodes).where(eq(discountCodes.code, values.code)).get();
}
async function updateDiscountCode(env, code, input) {
  const { fields, expectedVersion } = versionedInput(input);
  const values = discountCodeSchema.parse({ ...fields, code });
  const db = commerceDb(env);
  const current = await db.select().from(discountCodes).where(eq(discountCodes.code, values.code)).get();
  if (!current) throw new Error("Discount code not found");
  if (current.type !== values.type) throw new Error("Discount code type cannot be changed");
  if (current.type !== values.type || current.value !== values.value || current.minOrderCents !== values.minOrderCents || current.maxDiscountCents !== values.maxDiscountCents || current.firstOrderOnly !== values.firstOrderOnly || JSON.stringify(current.eligibleProductIds) !== JSON.stringify(values.eligibleProductIds)) {
    throw new Error("Financial terms are fixed when a code is created; create a new code for new terms");
  }
  const changed = await db.update(discountCodes).set({
    description: values.description,
    type: values.type,
    value: values.value,
    maxDiscountCents: values.maxDiscountCents,
    minOrderCents: values.minOrderCents,
    eligibleProductIds: values.eligibleProductIds,
    maxUses: values.maxUses,
    maxUsesPerCustomer: values.maxUsesPerCustomer,
    firstOrderOnly: values.firstOrderOnly,
    startsAt: values.startsAt ? new Date(values.startsAt * 1e3) : null,
    expiresAt: values.expiresAt ? new Date(values.expiresAt * 1e3) : null,
    active: values.active,
    updatedAt: sql`MAX(${discountCodes.updatedAt} + 1, ${Math.floor(Date.now() / 1e3)})`
  }).where(and(eq(discountCodes.code, values.code), expectedVersion === void 0 ? void 0 : expectedVersion === null ? sql`0` : eq(discountCodes.updatedAt, new Date(expectedVersion * 1e3)))).returning();
  if (!changed.length) throw new PromotionConflictError();
  return changed[0];
}

export {
  discountCodeSchema,
  referralSettingsSchema,
  discountAmountForLines,
  DiscountCodeRefusal,
  CODE_REFUSAL_MESSAGE,
  codeRefusalBody,
  evaluateDiscountCode,
  getPromotionsAdmin,
  setReferralCodeActive,
  PromotionConflictError,
  saveReferralSettings,
  createDiscountCode,
  updateDiscountCode
};
