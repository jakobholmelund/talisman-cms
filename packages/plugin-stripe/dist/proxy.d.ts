interface StripeProxyArgs {
    stripeSecretKey: string;
    stripeMethod: string;
    stripeArgs?: any[];
}
/**
 * A utility to securely invoke Stripe SDK methods on the server side.
 * Proxies calls like `customers.create` dynamically.
 *
 * @param args Request payload
 * @returns Serialized Response from Stripe
 */
declare const stripeProxy: (args: StripeProxyArgs) => Promise<any>;

export { type StripeProxyArgs, stripeProxy };
