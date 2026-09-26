import { and, count, eq, inArray } from 'drizzle-orm';
import { createDbClient, type TalismanEnv } from 'talisman-cms/client';
import { z } from 'zod';
import { customerAccounts, discountCodes, discountRedemptions, referralCodes, referralSettings } from './schema';
import { getReferralPolicy, referralTermsError } from './referrals';
import { hasPurchaseHistory } from './accounts';

const optionalLimit = z.number().int().positive().max(1_000_000).nullable();
const optionalDate = z.number().int().positive().nullable();
export const discountCodeSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{2,31}$/),
  description: z.string().trim().max(200).nullable(),
  type: z.enum(['credit', 'amount', 'percent']),
  value: z.number().int().positive().max(1_000_000),
  maxDiscountCents: optionalLimit,
  minOrderCents: z.number().int().min(0).max(10_000_000),
  eligibleProductIds: z.array(z.string().trim().min(1).max(128)).max(100),
  maxUses: optionalLimit,
  maxUsesPerCustomer: optionalLimit,
  firstOrderOnly: z.boolean(),
  startsAt: optionalDate,
  expiresAt: optionalDate,
  active: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (value.type === 'percent' && value.value > 10_000) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: 'Percent must be at most 100%' });
  }
  if (value.type === 'credit' && !/^GC-[A-F0-9]{24}$/.test(value.code)) {
    ctx.addIssue({ code: 'custom', path: ['code'], message: 'Credit voucher codes must be generated securely' });
  }
  if (value.type !== 'percent' && value.maxDiscountCents !== null) {
    ctx.addIssue({ code: 'custom', path: ['maxDiscountCents'], message: 'Only percent codes support a cap' });
  }
  if (value.startsAt && value.expiresAt && value.expiresAt <= value.startsAt) {
    ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Expiry must follow the start date' });
  }
  if (new Set(value.eligibleProductIds).size !== value.eligibleProductIds.length) {
    ctx.addIssue({ code: 'custom', path: ['eligibleProductIds'], message: 'Product IDs must be unique' });
  }
});
export type DiscountCodeInput = z.infer<typeof discountCodeSchema>;

export const referralSettingsSchema = z.object({
  enabled: z.boolean(),
  rewardCents: z.number().int().min(1).max(100_000),
  minOrderCents: z.number().int().min(1).max(10_000_000),
  attributionDays: z.number().int().min(1).max(90),
}).strict().superRefine((value, ctx) => {
  // Terms saved while off are not in force, and a policy with invalid terms attributes nothing.
  const termsError = value.enabled ? referralTermsError(value) : null;
  if (termsError) ctx.addIssue({ code: 'custom', path: ['rewardCents'], message: termsError });
});

export function discountAmountForLines(code: Pick<typeof discountCodes.$inferSelect,
  'type' | 'value' | 'remainingCents' | 'maxDiscountCents' | 'minOrderCents' | 'eligibleProductIds'>,
  lines: Array<{ productId: string; quantity: number; priceAtPurchase: number }>, subtotal: number) {
  if (!Number.isSafeInteger(subtotal) || subtotal < code.minOrderCents) return 0;
  const eligible = code.eligibleProductIds.length
    ? lines.filter((line) => code.eligibleProductIds.includes(line.productId)) : lines;
  const eligibleSubtotal = eligible.reduce((sum, line) => sum + line.priceAtPurchase * line.quantity, 0);
  if (!Number.isSafeInteger(eligibleSubtotal) || eligibleSubtotal <= 0) return 0;
  const raw = code.type === 'percent' ? Number(BigInt(eligibleSubtotal) * BigInt(code.value) / 10_000n)
    : code.type === 'credit' ? Math.min(code.remainingCents ?? 0, eligibleSubtotal)
    : Math.min(code.value, eligibleSubtotal);
  const capped = code.type === 'percent' && code.maxDiscountCents !== null
    ? Math.min(raw, code.maxDiscountCents) : raw;
  // Keep the USD card charge at Stripe's minimum; store credit is applied afterward.
  return Math.max(0, Math.min(capped, subtotal - 50));
}

export async function evaluateDiscountCode(env: TalismanEnv, input: {
  code: string; customerEmail: string; accountId?: string | null;
  lines: Array<{ productId: string; quantity: number; priceAtPurchase: number }>;
  subtotal: number;
}) {
  const normalizedCode = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(normalizedCode)) throw new Error('Invalid discount code');
  const db = createDbClient(env);
  const code = await db.select().from(discountCodes).where(eq(discountCodes.code, normalizedCode)).get();
  if (!code || !code.active) throw new Error('Discount code is unavailable');
  const now = Date.now();
  if (code.startsAt && code.startsAt.getTime() > now || code.expiresAt && code.expiresAt.getTime() <= now) {
    throw new Error('Discount code is outside its active dates');
  }
  const account = input.accountId ? await db.select().from(customerAccounts)
    .where(eq(customerAccounts.id, input.accountId)).get() : null;
  const emailNormalized = (account?.emailNormalized ?? input.customerEmail.trim().toLowerCase());
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNormalized)) throw new Error('Valid email required for a discount');
  // A first purchase means no paid order yet. Signing up or asking for a sign-in link does not count.
  if (code.firstOrderOnly && await hasPurchaseHistory(env, { emails: [emailNormalized], accountIds: [account?.id] })) {
    throw new Error('Discount is for a first purchase only');
  }
  if (code.maxUses !== null) {
    const [{ uses }] = await db.select({ uses: count() }).from(discountRedemptions)
      .where(and(eq(discountRedemptions.code, code.code),
        inArray(discountRedemptions.status, ['reserved', 'confirmed'])));
    if (uses >= code.maxUses) throw new Error('Discount code has reached its use limit');
  }
  if (code.maxUsesPerCustomer !== null) {
    const [{ uses }] = await db.select({ uses: count() }).from(discountRedemptions)
      .where(and(eq(discountRedemptions.code, code.code),
        eq(discountRedemptions.emailNormalized, emailNormalized),
        inArray(discountRedemptions.status, ['reserved', 'confirmed'])));
    if (uses >= code.maxUsesPerCustomer) throw new Error('Discount code was already used by this shopper');
  }
  const amount = discountAmountForLines(code, input.lines, input.subtotal);
  if (!amount) throw new Error('Discount code does not apply to this basket');
  return { code: code.code, type: code.type, amount, emailNormalized };
}

export async function getPromotionsAdmin(env: TalismanEnv) {
  const db = createDbClient(env);
  const codes = await db.select().from(discountCodes).orderBy(discountCodes.createdAt);
  const usage = await db.select({ code: discountRedemptions.code, status: discountRedemptions.status,
    uses: count() }).from(discountRedemptions)
    .groupBy(discountRedemptions.code, discountRedemptions.status);
  const referralLinks = await db.select({ code: referralCodes.code,
    active: referralCodes.active, email: customerAccounts.email })
    .from(referralCodes).innerJoin(customerAccounts, eq(referralCodes.accountId, customerAccounts.id));
  return { referral: await getReferralPolicy(env), referralLinks, codes, usage };
}

export async function setReferralCodeActive(env: TalismanEnv, code: string, active: boolean) {
  if (!/^REF-[A-F0-9]{20}$/.test(code) || typeof active !== 'boolean') {
    throw new Error('Invalid referral code status');
  }
  const db = createDbClient(env);
  const changed = await db.update(referralCodes).set({ active })
    .where(eq(referralCodes.code, code)).returning({ code: referralCodes.code });
  if (!changed.length) throw new Error('Referral code not found');
  return { code, active };
}

export async function saveReferralSettings(env: TalismanEnv, input: unknown) {
  const parsed = referralSettingsSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => issue.message).join('; '));
  const values = parsed.data;
  const db = createDbClient(env);
  await db.insert(referralSettings).values({ id: 'default', ...values, updatedAt: new Date() })
    .onConflictDoUpdate({ target: referralSettings.id, set: { ...values, updatedAt: new Date() } });
  return getReferralPolicy(env);
}

export async function createDiscountCode(env: TalismanEnv, input: unknown) {
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const generatedCode = raw.type === 'credit'
    ? `GC-${Array.from(crypto.getRandomValues(new Uint8Array(12)),
      byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase()}` : raw.code;
  const values = discountCodeSchema.parse({ ...raw, code: generatedCode });
  const now = new Date();
  const db = createDbClient(env);
  await db.insert(discountCodes).values({ ...values,
    remainingCents: values.type === 'credit' ? values.value : null,
    startsAt: values.startsAt ? new Date(values.startsAt * 1000) : null,
    expiresAt: values.expiresAt ? new Date(values.expiresAt * 1000) : null,
    createdAt: now, updatedAt: now });
  return db.select().from(discountCodes).where(eq(discountCodes.code, values.code)).get();
}

export async function updateDiscountCode(env: TalismanEnv, code: string, input: unknown) {
  const values = discountCodeSchema.parse({ ...(input as object), code });
  const db = createDbClient(env);
  const current = await db.select().from(discountCodes).where(eq(discountCodes.code, values.code)).get();
  if (!current) throw new Error('Discount code not found');
  if (current.type !== values.type) throw new Error('Discount code type cannot be changed');
  if (current.type !== values.type || current.value !== values.value ||
      current.minOrderCents !== values.minOrderCents ||
      current.maxDiscountCents !== values.maxDiscountCents ||
      current.firstOrderOnly !== values.firstOrderOnly ||
      JSON.stringify(current.eligibleProductIds) !== JSON.stringify(values.eligibleProductIds)) {
    throw new Error('Financial terms are fixed when a code is created; create a new code for new terms');
  }
  await db.update(discountCodes).set({
    description: values.description, type: values.type, value: values.value,
    maxDiscountCents: values.maxDiscountCents, minOrderCents: values.minOrderCents,
    eligibleProductIds: values.eligibleProductIds, maxUses: values.maxUses,
    maxUsesPerCustomer: values.maxUsesPerCustomer, firstOrderOnly: values.firstOrderOnly,
    startsAt: values.startsAt ? new Date(values.startsAt * 1000) : null,
    expiresAt: values.expiresAt ? new Date(values.expiresAt * 1000) : null,
    active: values.active, updatedAt: new Date()
  }).where(eq(discountCodes.code, values.code));
  return db.select().from(discountCodes).where(eq(discountCodes.code, values.code)).get();
}
