declare const CART_UPDATED_EVENT = "talisman:cart-updated";
interface CartUpdatedDetail {
    itemCount: number;
}
interface TalismanEcommerceBrowserHelpers {
    CART_UPDATED_EVENT: typeof CART_UPDATED_EVENT;
    dispatchCartUpdated: (detail: CartUpdatedDetail) => void;
}
declare global {
    interface Window {
        TalismanEcommerce?: TalismanEcommerceBrowserHelpers;
    }
}
declare function dispatchCartUpdated(detail: CartUpdatedDetail): void;
interface CustomerAccountSummary {
    id: string;
    email: string;
    name: string | null;
}
declare function getCustomerAccount(): Promise<{
    account: CustomerAccountSummary | null;
}>;
/** Deprecated: checkout alone cannot verify account ownership. */
declare function activateNewCustomerAccount(orderId: string): Promise<{
    account: CustomerAccountSummary;
}>;
/**
 * Asks for a sign-in link. Pass `turnstileToken` when the site configures a bot check (see
 * `shopperSignInBotCheck` in `@talisman-cms/plugin-ecommerce/accounts`); a missing or failed check is
 * refused with "The security check failed. Please try again." `limited: true` means today's general
 * sign-in email budget is spent: only existing customers still receive a link, and every address
 * gets this same answer.
 */
declare function requestCustomerEmailSignIn(email: string, options?: {
    turnstileToken?: string;
}): Promise<{
    accepted: true;
    limited?: true;
}>;
type SignInLocation = Pick<Location, 'pathname' | 'search' | 'hash'>;
type SignInHistory = Pick<History, 'replaceState' | 'state'>;
/**
 * Reads the one-time token on the page a sign-in link opens, then removes it from the address bar.
 * Links carry it in the fragment (`/account/verify#token=...`), which browsers never send to the
 * server. `?token=` links sent before that change are still read. Returns null without a token.
 */
declare function readCustomerSignInToken(loc?: SignInLocation | undefined, hist?: SignInHistory | undefined): string | null;
/**
 * The address a sign-in link belongs to, masked as `{ email: 'j•••@example.com' }`, so the verify page
 * can show which account the shopper is about to open. The link stays usable and no session is
 * created. Rejects with "This sign-in link is invalid or has expired." for a used or expired link.
 */
declare function previewCustomerSignIn(token: string): Promise<{
    email: string;
}>;
declare function verifyCustomerEmailSignIn(token: string): Promise<{
    account: CustomerAccountSummary;
}>;
declare function signOutCustomerAccount(): Promise<{
    account: null;
}>;
declare function chooseCustomerBasket(choice: 'browser' | 'account'): Promise<{
    cart: {
        id: string;
    };
}>;
declare function startCheckout(input?: {
    customerEmail?: string;
    discountCode?: string;
    giftCardCode?: string;
    shippingAddress?: Record<string, string>;
    /** When the store charges tax and nothing ships, tax is calculated for this address, so it needs a country. */
    billingAddress?: Record<string, string>;
    /** The id of one of the store's shipping options for the country. Without it, the first option. */
    shippingRateId?: string;
}): Promise<{
    orderId: string;
    redirectUrl: string;
}>;
/**
 * Available only to authenticated CMS administrators, and only when the site registers
 * ecommercePlugin({ adminTestCheckout: true }). Creates a simulated payment.
 * Pass `adminPath` when talismanCms({ adminPath }) is not `/admin`.
 */
declare function startAdminTestCheckout(input?: {
    customerEmail?: string;
    shippingAddress?: Record<string, string>;
    billingAddress?: Record<string, string>;
    shippingRateId?: string;
}, options?: {
    adminPath?: string;
}): Promise<{
    orderId: string;
    status: string;
    paymentProvider: "admin_test";
    redirectUrl: string;
}>;
declare function getOrderStatus(orderId: string): Promise<{
    orderId: string;
    status: string;
    paymentProvider: string | null;
    accountCreatedByOrder: boolean;
    accountLinked: boolean;
    totalAmount: number;
    subtotalAmount: number;
    shippingAmount: number;
    shippingLabel: string | null;
    taxAmount: number;
    taxBehavior: "inclusive" | "exclusive" | null;
    creditApplied: number;
    discountCode: string | null;
    discountAmount: number;
    giftCardApplied: number;
    giftCardRefundedCents: number;
    providerRefundedCents: number;
    currency: string;
}>;
declare function cancelCheckout(orderId: string): Promise<{
    orderId: string;
    status: string;
}>;
declare function installTalismanEcommerceBrowserHelpers(target?: Window): TalismanEcommerceBrowserHelpers;

export { CART_UPDATED_EVENT, type CartUpdatedDetail, type CustomerAccountSummary, type TalismanEcommerceBrowserHelpers, activateNewCustomerAccount, cancelCheckout, chooseCustomerBasket, dispatchCartUpdated, getCustomerAccount, getOrderStatus, installTalismanEcommerceBrowserHelpers, previewCustomerSignIn, readCustomerSignInToken, requestCustomerEmailSignIn, signOutCustomerAccount, startAdminTestCheckout, startCheckout, verifyCustomerEmailSignIn };
