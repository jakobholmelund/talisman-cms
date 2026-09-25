import { TalismanEnv } from 'talisman-cms/client';

declare const CUSTOMER_SESSION_COOKIE = "talisman-customer";
declare const CUSTOMER_SESSION_MAX_AGE: number;
/** Store-wide sign-in emails per 24 hours unless `TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT` sets another positive whole number. */
declare const CUSTOMER_EMAIL_DAILY_LIMIT = 200;
/** Order statuses that count as a purchase for first-order promotions and referrals. */
declare const PURCHASED_ORDER_STATUSES: readonly ["paid", "fulfilled", "partially_refunded", "refunded"];
/** The store-wide daily sign-in email limit is used up; the request sent nothing. */
declare class CustomerEmailLimitError extends Error {
    readonly name = "CustomerEmailLimitError";
    constructor();
}
/** One IP address made too many requests; nothing was read or changed. */
declare class CustomerRequestLimitError extends Error {
    readonly name = "CustomerRequestLimitError";
    constructor();
}
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
/**
 * Sends a one-time link to `email`. The caller must deliver it to the address it is given. Only the
 * token's hash and the address are stored; no shopper account exists until the link is used.
 * A rate-limited request returns without sending, so callers can answer it like any other. Throws
 * `CustomerEmailLimitError` once the store has sent its daily number of sign-in emails.
 */
declare function requestCustomerEmailSignIn(env: TalismanEnv, email: string, linkForToken: (token: string) => string, sendLink: (to: string, link: string) => Promise<void>, sourceIp?: string | null): Promise<void>;
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

export { CUSTOMER_EMAIL_DAILY_LIMIT, CUSTOMER_SESSION_COOKIE, CUSTOMER_SESSION_MAX_AGE, CustomerEmailLimitError, CustomerRequestLimitError, PURCHASED_ORDER_STATUSES, activateNewCustomer, consumeCustomerEmailSignIn, findCustomerSession, hasPurchaseHistory, listCustomerOrders, previewCustomerEmailSignIn, requestCustomerEmailSignIn, revokeCustomerSession };
