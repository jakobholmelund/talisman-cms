import { TalismanEnv } from 'talisman-cms/client';

declare const CUSTOMER_SESSION_COOKIE = "talisman-customer";
declare const CUSTOMER_SESSION_MAX_AGE: number;
/** Store-wide sign-in emails per 24 hours unless `TALISMAN_COMMERCE_EMAIL_DAILY_LIMIT` sets another positive whole number. */
declare const CUSTOMER_EMAIL_DAILY_LIMIT = 200;
/** The store-wide daily sign-in email limit is used up; the request sent nothing. */
declare class CustomerEmailLimitError extends Error {
    readonly name = "CustomerEmailLimitError";
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
 * The caller must deliver the link to the account's email address. A rate-limited request returns
 * without sending, so callers can answer it like any other. Throws `CustomerEmailLimitError` once
 * the store has sent its daily number of sign-in emails.
 */
declare function requestCustomerEmailSignIn(env: TalismanEnv, email: string, linkForToken: (token: string) => string, sendLink: (to: string, link: string) => Promise<void>, sourceIp?: string | null): Promise<void>;
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

export { CUSTOMER_EMAIL_DAILY_LIMIT, CUSTOMER_SESSION_COOKIE, CUSTOMER_SESSION_MAX_AGE, CustomerEmailLimitError, activateNewCustomer, consumeCustomerEmailSignIn, findCustomerSession, listCustomerOrders, requestCustomerEmailSignIn, revokeCustomerSession };
