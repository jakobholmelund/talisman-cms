import { TalismanEnv } from 'talisman-cms/client';

declare const CUSTOMER_SESSION_COOKIE = "talisman-customer";
declare const CUSTOMER_SESSION_MAX_AGE: number;
/** Store-wide sign-in emails per 24 hours unless `TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT` sets another positive whole number. */
declare const CUSTOMER_EMAIL_DAILY_LIMIT = 200;
/** Order statuses that count as a purchase for first-order promotions and referrals. */
declare const PURCHASED_ORDER_STATUSES: readonly ["paid", "fulfilled", "partially_refunded", "refunded"];
/**
 * Kept for compatibility: `requestCustomerEmailSignIn` no longer throws it and answers a spent daily
 * budget with `{ limited: true }` instead.
 */
declare class CustomerEmailLimitError extends Error {
    readonly name = "CustomerEmailLimitError";
    constructor();
}
/** One IP address made too many requests; nothing was read or changed. */
declare class CustomerRequestLimitError extends Error {
    readonly name = "CustomerRequestLimitError";
    constructor();
}
/**
 * The lowercased address, or null. Only a bare address is accepted, checked with the same rule the
 * email module applies to recipients, so a display name such as `a<victim@example.com>` can never
 * change who receives the link.
 */
declare function normalizeShopperEmail(email: unknown): string | null;
declare function findCustomerSession(env: TalismanEnv, token?: string | null): Promise<{
    id: string;
    cmsUserId: string | null;
    email: string;
    emailNormalized: string;
    emailVerifiedAt: Date | null;
    name: string | null;
    creditBalance: number;
    createdAt: Date;
    updatedAt: Date;
} | null>;
/**
 * The bot check a storefront should render in its sign-in form, or null when none is configured.
 * It is on when both `TALISMAN_COMMERCE_TURNSTILE_SITE_KEY` and `TALISMAN_COMMERCE_TURNSTILE_SECRET_KEY`
 * are set; the account route then refuses email sign-in requests without a valid `turnstileToken`.
 */
declare function shopperSignInBotCheck(env: TalismanEnv): {
    provider: 'turnstile';
    siteKey: string;
    action: string;
} | null;
/** Basket possession never proves ownership of the checkout email. */
declare function activateNewCustomer(_env: TalismanEnv, _orderId: string, _basketToken: string): Promise<null>;
/**
 * Whether a shopper has bought before: a paid, fulfilled or refunded order under one of `accountIds`,
 * placed with one of `emails`, or owned by an account with one of those emails. Admin test orders do
 * not count. First-order promotions and referrals use this, never whether an account row exists.
 */
declare function hasPurchaseHistory(env: TalismanEnv, shopper: {
    emails?: Array<string | null | undefined>;
    accountIds?: Array<string | null | undefined>;
}): Promise<boolean>;
interface CustomerEmailSignInOptions {
    /**
     * Runs work after the response, such as the Worker's `waitUntil`. Once the general daily budget is
     * spent, the customer lookup and any send from the reserved budget run through it, so the answer
     * takes the same time for every address. Without it that work runs before the call returns.
     */
    waitUntil?: (task: Promise<unknown>) => void;
    /**
     * Receives a failed send from the reserved budget. That failure is never thrown, so the answer stays
     * the same for every address. Defaults to logging the error's name.
     */
    onLimitedSendError?: (error: unknown) => void;
}
/**
 * Sends a one-time link to `email`. The caller must deliver it to the address it is given. Only the
 * token's hash and the address are stored; no shopper account exists until the link is used.
 * A rate-limited request returns without sending, so callers can answer it like any other.
 *
 * The store-wide daily limit has two pools. The general pool (the limit minus the reserve) serves any
 * address. Once it is spent the call returns `{ limited: true }` for every address, and sends only to
 * an address with a verified account or a purchase, while the reserved pool lasts and at most
 * twice a day per address. Otherwise it returns `{ limited: false }`. Send failures outside the
 * limited state are thrown.
 */
declare function requestCustomerEmailSignIn(env: TalismanEnv, email: string, linkForToken: (token: string) => string, sendLink: (to: string, link: string) => Promise<void>, sourceIp?: string | null, options?: CustomerEmailSignInOptions): Promise<{
    limited: boolean;
}>;
/**
 * The masked address an unused sign-in link was sent to, for example `j•••@example.com`, so a
 * storefront can show which account the link opens before the shopper confirms. The link stays
 * usable. Returns null for an unknown, used or expired link. Throws `CustomerRequestLimitError`
 * when `sourceIp` has asked too often.
 */
declare function previewCustomerEmailSignIn(env: TalismanEnv, token: unknown, sourceIp?: string | null): Promise<string | null>;
/**
 * Uses a sign-in link once. Using it proves control of the address, so this is where the shopper
 * account is created (already verified) or linked, and where it joins the shared CMS identity.
 */
declare function consumeCustomerEmailSignIn(env: TalismanEnv, token: string): Promise<{
    account: {
        id: string;
        cmsUserId: string | null;
        email: string;
        emailNormalized: string;
        emailVerifiedAt: Date | null;
        name: string | null;
        creditBalance: number;
        createdAt: Date;
        updatedAt: Date;
    };
    token: string;
} | null>;
declare function revokeCustomerSession(env: TalismanEnv, token?: string | null): Promise<void>;
declare function listCustomerOrders(env: TalismanEnv, accountId: string): Promise<{
    id: string;
    status: string;
    totalAmount: number;
    subtotalAmount: number;
    creditApplied: number;
    currency: string;
    createdAt: Date;
}[]>;

export { CUSTOMER_EMAIL_DAILY_LIMIT, CUSTOMER_SESSION_COOKIE, CUSTOMER_SESSION_MAX_AGE, CustomerEmailLimitError, type CustomerEmailSignInOptions, CustomerRequestLimitError, PURCHASED_ORDER_STATUSES, activateNewCustomer, consumeCustomerEmailSignIn, findCustomerSession, hasPurchaseHistory, listCustomerOrders, normalizeShopperEmail, previewCustomerEmailSignIn, requestCustomerEmailSignIn, revokeCustomerSession, shopperSignInBotCheck };
