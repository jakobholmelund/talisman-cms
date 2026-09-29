import { SQL } from 'drizzle-orm';
import { TalismanEnv } from 'talisman-cms/client';

/** Invalid input to an order adjustment. The admin route answers it with 400. */
declare class OrderAdjustmentInputError extends Error {
    readonly name = "OrderAdjustmentInputError";
}
/** An adjustment the order's current state does not allow; the message says why. The admin route answers 409. */
declare class OrderAdjustmentRefusedError extends Error {
    readonly name = "OrderAdjustmentRefusedError";
}
/**
 * Statements that apply a full refund's effects once the order is 'refunded': its promotion and gift
 * card redemptions become refunded (the database triggers return a credit voucher's balance and the
 * gift card's value) and the store credit it used goes back to the shopper. Each is guarded by the
 * order's status and repeats safely, so add them after the statement that refunds the order. A
 * provider refund of the whole charge and a lost dispute both use them.
 */
declare function fullRefundStatements(orderId: string, now: number): SQL[];
type ReservationType = 'inventory' | 'component';
type TargetType = 'product' | 'variant' | 'stock' | 'component';
/** A reservation row of an order: the stock one line of it took, and whether that went back. */
type OrderReservation = {
    type: ReservationType;
    id: string;
    targetType: TargetType;
    targetId: string;
    /** The catalog's current name for the stock; null when the record no longer exists. */
    label: string | null;
    sku: string | null;
    quantity: number;
    /** When the stock went back: by a restock, or by the cancellation of an unpaid checkout. */
    returnedAt: string | null;
    restock: {
        adminActor: string;
        reason: string;
        createdAt: string;
    } | null;
    /** Whether the stock record still exists, so the row can be returned to it. */
    available: boolean;
};
type OrderDispute = {
    id: string;
    status: string;
    open: boolean;
    reason: string | null;
    amountCents: number;
    currency: string;
    statusBefore: string;
    createdAt: string;
    closedAt: string | null;
};
/**
 * Disputes and stock for the admin orders screen, by order id: each order's payment disputes, oldest
 * first; its reservation rows with what went back to stock, when and by whom; whether it can be
 * restocked now ('all' rows of a refunded order, 'choose' rows of a partly refunded one, or null);
 * and how much of it shipped, since shipped goods come back only when the buyer returns them.
 * Order ids that match no order are left out.
 */
declare function getOrderAdjustmentsAdmin(env: TalismanEnv, input: unknown): Promise<{
    orders: {
        [k: string]: {
            orderId: string;
            status: string;
            fulfillmentStatus: "unfulfilled" | "partially_fulfilled" | "fulfilled";
            restock: "all" | "choose" | null;
            disputes: OrderDispute[];
            reservations: OrderReservation[];
        };
    };
}>;
/**
 * Returns stock that a refunded order took, and records who returned it and why in
 * _ecommerce_restocks. Without `reservations`, every row of a refunded order not yet returned goes
 * back; a partially refunded order needs the rows chosen. Stock is added to its current value, and
 * each reservation row is marked released, so no row goes back twice, whether restocked again or
 * cancelled. Pending, cancelled, paid, disputed and admin test orders are refused with
 * OrderAdjustmentRefusedError, invalid input with OrderAdjustmentInputError.
 */
declare function restockOrder(env: TalismanEnv, actor: string, input: unknown): Promise<{
    orderId: string;
    restocked: {
        type: ReservationType;
        reservationId: string;
        targetType: TargetType;
        targetId: string;
        quantity: number;
    }[];
}>;

export { OrderAdjustmentInputError, OrderAdjustmentRefusedError, type OrderDispute, type OrderReservation, fullRefundStatements, getOrderAdjustmentsAdmin, restockOrder };
