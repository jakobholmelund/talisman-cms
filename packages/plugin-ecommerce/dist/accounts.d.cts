import { TalismanEnv } from 'talisman-cms/client';

declare const CUSTOMER_SESSION_COOKIE = "talisman-customer";
declare const CUSTOMER_SESSION_MAX_AGE: number;
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
/** The caller must deliver the link to the account's email address. */
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

export { CUSTOMER_SESSION_COOKIE, CUSTOMER_SESSION_MAX_AGE, activateNewCustomer, consumeCustomerEmailSignIn, findCustomerSession, listCustomerOrders, requestCustomerEmailSignIn, revokeCustomerSession };
