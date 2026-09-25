import { PeriodDays } from './cloudflare.js';

type Database = Pick<D1Database, 'prepare'>;
/**
 * How refunds are dated. `refund_date`: each refund counts on the day it was issued.
 * `payment_date`: refunds count on the payment date of the refunded order, because the store
 * does not record when provider refunds were issued (no `_ecommerce_provider_refunds` table).
 */
type RefundBasis = 'refund_date' | 'payment_date';
/**
 * The store's Stripe mode: `live` only when the COMMERCE_STRIPE_MODE setting is `live`, as in
 * plugin-ecommerce. A live store's reports exclude Stripe test-mode orders. A store in test mode
 * takes Stripe payments only in test mode, so its reports include them.
 */
type StripeMode = 'live' | 'test';
type CommerceOverview = {
    periodDays: PeriodDays;
    start: string;
    end: string;
    refundBasis: RefundBasis;
    /** Stripe test-mode orders are excluded in `live` mode and included in `test` mode. */
    stripeMode: StripeMode;
    /** True when some refunds in the period have no recorded date and were counted on the payment date. */
    undatedRefunds: boolean;
    currencies: Array<{
        currency: string;
        orders: number;
        grossSales: number;
        netSales: number;
        refunds: number;
        refundedOrders: number;
        charged: number;
        averageOrderValue: number;
    }>;
    daily: Array<{
        date: string;
        currency: string;
        orders: number;
        netSales: number;
    }>;
    products: Array<{
        id: string;
        name: string;
        currency: string;
        units: number;
        itemSales: number;
        editHref: string;
    }>;
};
type CommerceRange = Omit<CommerceOverview, 'periodDays'>;
/**
 * Provider refunds with the time they were issued, one row per refund, written by plugin-ecommerce
 * when available. Per order the rows should add up to provider_refunded_cents; any excess is ignored.
 */
declare const providerRefundsTable = "_ecommerce_provider_refunds";
/**
 * Sales are counted on the payment date. Refunds are counted on their own date (see RefundBasis),
 * and net sales are gross sales less the refunds counted in the same period. Stripe test-mode orders
 * are left out unless `stripeMode` is `test`.
 */
declare function commerceSql(refundBasis: RefundBasis, stripeMode?: StripeMode): {
    totals: string;
    daily: string;
    products: string;
};
/** Refund dates are available once plugin-ecommerce records provider refunds in their own table. */
declare function detectRefundBasis(db: Database): Promise<RefundBasis>;
/** Pass the store's Stripe mode; without one the report treats the store as live and leaves test-mode orders out. */
declare function fetchCommerceRange(db: Database, start: string, end: string, adminBase?: string, productCollectionSlug?: string, stripeMode?: StripeMode): Promise<CommerceRange>;
declare function fetchCommerceOverview(db: Database, days: PeriodDays, adminBase?: string, productCollectionSlug?: string, stripeMode?: StripeMode, now?: Date): Promise<CommerceOverview>;

export { type CommerceOverview, type CommerceRange, type RefundBasis, type StripeMode, commerceSql, detectRefundBasis, fetchCommerceOverview, fetchCommerceRange, providerRefundsTable };
