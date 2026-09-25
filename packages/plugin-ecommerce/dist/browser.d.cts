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
declare function requestCustomerEmailSignIn(email: string): Promise<{
    accepted: true;
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
    billingAddress?: Record<string, string>;
}): Promise<{
    orderId: string;
    redirectUrl: string;
}>;
/** Available only to authenticated CMS administrators. Creates a simulated payment. */
declare function startAdminTestCheckout(input?: {
    customerEmail?: string;
    shippingAddress?: Record<string, string>;
    billingAddress?: Record<string, string>;
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

export { CART_UPDATED_EVENT, type CartUpdatedDetail, type CustomerAccountSummary, type TalismanEcommerceBrowserHelpers, activateNewCustomerAccount, cancelCheckout, chooseCustomerBasket, dispatchCartUpdated, getCustomerAccount, getOrderStatus, installTalismanEcommerceBrowserHelpers, requestCustomerEmailSignIn, signOutCustomerAccount, startAdminTestCheckout, startCheckout, verifyCustomerEmailSignIn };
