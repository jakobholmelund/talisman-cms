import { TalismanEnv } from 'talisman-cms/client';

type OrderAmount = {
    key: string;
    label: string;
    cents: number;
};

/** Orders per page of the admin orders queue unless a request asks for another size. */
declare const ORDERS_PAGE_SIZE = 50;
/** The largest page a request may ask for. */
declare const ORDERS_PAGE_MAX = 100;
type OrdersView = 'awaiting' | 'recent';
type FulfillmentStatus = 'unfulfilled' | 'partially_fulfilled' | 'fulfilled';
/** Invalid input to the orders queue or to a shipment write. The admin route answers it with 400. */
declare class FulfillmentInputError extends Error {
    readonly name = "FulfillmentInputError";
}
type Correction = {
    id: string;
    createdAt: string;
    adminActor: string;
    carrier: string | null;
    trackingNumber: string | null;
    reason: string;
};
/** A shipment with the carrier and tracking number in force, as first recorded, and its corrections. */
type Shipment = {
    id: string;
    createdAt: string;
    adminActor: string;
    note: string;
    completesOrder: boolean;
    carrier: string | null;
    trackingNumber: string | null;
    recorded: {
        carrier: string | null;
        trackingNumber: string | null;
    };
    corrections: Correction[];
};
/**
 * One page of the admin orders queue. The `awaiting` view (the default) lists every real order that
 * can still ship, oldest first; `recent` lists real orders past checkout, newest first. Neither lists
 * admin test orders. Further pages follow `nextCursor`. `awaitingCount` counts every order awaiting
 * shipment, whatever the view, page or query. `query` is an exact order id or an email address.
 * Items carry the catalog's current names and SKUs, and each amount carries its label.
 */
declare function listCommerceOrdersAdmin(env: TalismanEnv, options?: {
    view?: OrdersView;
    cursor?: string | null;
    limit?: number;
    query?: string | null;
}): Promise<{
    view: "awaiting" | "recent";
    pageSize: number;
    awaitingCount: number;
    nextCursor: string | null;
    orders: {
        id: string;
        status: string;
        fulfillmentStatus: FulfillmentStatus;
        paymentProvider: string;
        customerEmail: string | null;
        currency: string;
        createdAt: string;
        shippingAddress: Record<string, string> | null;
        canShip: boolean;
        items: {
            productId: string;
            variantId: string | null;
            quantity: number;
            unitAmount: number;
            lineTotal: number;
            productName: string | null;
            variantLabel: string | null;
            sku: string | null;
        }[];
        amounts: OrderAmount[];
        shipments: Shipment[];
    }[];
}>;
/**
 * Records a shipment of a paid real order that has not shipped in full. It completes the order
 * unless `completesOrder` is false, which records one parcel of a split shipment. The database
 * trigger enforces the same rules. A later refund or dispute changes only the payment status.
 * The buyer is emailed a shipment notice with the carrier and tracking number; a failed send never
 * fails the shipment, and the scheduled job retries it.
 */
declare function fulfillCommerceOrder(env: TalismanEnv, actor: string, input: unknown): Promise<{
    fulfillmentId: string;
    orderId: string;
    status: string | undefined;
    fulfillmentStatus: FulfillmentStatus | undefined;
}>;
/**
 * Appends a correction that restates a shipment's carrier and tracking number, with the reason.
 * The shipment row never changes, so its history stays readable. A correction ships nothing, so any
 * payment status allows it; admin test orders do not. When the shipment's notice already went out (or
 * is being sent), the buyer gets an updated notice with the corrected details; a notice not sent yet
 * carries them anyway, since notices read the details in force when they are sent.
 */
declare function correctCommerceFulfillment(env: TalismanEnv, actor: string, input: unknown): Promise<{
    correctionId: string;
    fulfillmentId: string;
    orderId: string;
    carrier: string | null;
    trackingNumber: string | null;
}>;

export { FulfillmentInputError, type FulfillmentStatus, ORDERS_PAGE_MAX, ORDERS_PAGE_SIZE, type OrdersView, correctCommerceFulfillment, fulfillCommerceOrder, listCommerceOrdersAdmin };
