import { TalismanEnv } from 'talisman-cms/client';
import { StocktakeLine, ParcelItem, InspectedItem, ReturnedItem, RETURN_REFUND_STATUSES, returnRefundDecisions, REFUND_SOURCE_KINDS, RESTOCK_TARGET_TYPES, replenishmentPolicies, replenishmentDeliveries } from './schema.js';
import * as drizzle_orm_sqlite_core from 'drizzle-orm/sqlite-core';
export { d as decideReturnRequest, l as listReturnsQueue, r as readReturnRequestAdmin } from './return-requests-CqFKKpcO.js';
import 'drizzle-orm';
import './return-request-types-BRQL27cB.js';

type AttentionKind = 'payment_review' | 'older_payments' | 'tax_review' | 'email' | 'gift_hold' | 'shipment' | 'dispute' | 'return_request' | 'inspection' | 'refund' | 'incoming';
/** A read-only snapshot. Exact counts include every matching record; each category shows its ten
 * oldest records. No buyer addresses, provider credentials or gift card codes leave this query. */
declare function readCommerceAttention(env: TalismanEnv, now?: number): Promise<{
    checkedAt: string;
    counts: Partial<Record<AttentionKind, number>>;
    rows: {
        createdAt: string;
        kind: AttentionKind;
        id: string;
        subject: string;
        detail: string | null;
    }[];
}>;

declare class CommerceOperationsConflict extends Error {
    readonly name = "CommerceOperationsConflict";
}
declare function listEmailRecovery(env: TalismanEnv, input?: unknown): Promise<{
    rows: {
        retryable: boolean;
        guidance: string;
        id: string;
        kind: "shipment" | "order_confirmation" | "shipment_update" | "gift_card_claim" | "return_decision" | "return_received";
        subjectId: string;
        status: "cancelled" | "pending" | "sent" | "failed";
        attempts: number;
        lastError: string | null;
        nextAttemptAt: Date;
        claimedAt: Date | null;
        retryRequestId: string | null;
        createdAt: Date;
        eligible: boolean;
    }[];
    total: number;
    offset: number;
    history: {
        actorName: string;
        id: string;
        emailId: string;
        actor: string;
        reason: string;
        priorAttempts: number;
        priorError: string | null;
        createdAt: Date;
    }[];
}>;
/** Queues a fresh attempt, never sends from the admin request. Replaying a key returns its receipt
 * even after another delivery failure, without resetting the queue a second time. */
declare function retryCommerceEmail(env: TalismanEnv, input: unknown, actor: string): Promise<{
    decisionId: string;
    emailId: string;
    requestedAt: Date;
    delivery: {
        status: "cancelled" | "pending" | "sent" | "failed";
        attempts: number;
        lastError: string | null;
    } | undefined;
}>;

type StockOverviewRow = {
    id: string;
    kind: 'product' | 'variant' | 'value' | 'component';
    productId: string | null;
    name: string;
    sku: string | null;
    quantity: number;
    source: string;
};
/** Filtering and pagination happen after effective quantities are computed, so low stock beyond
 * the first catalog page remains discoverable. Bound search treats SQL wildcard characters literally. */
declare function readStockOverview(env: TalismanEnv, input?: unknown): Promise<{
    search: string;
    offset: number;
    filter: "all" | "unavailable" | "low";
    view: "components" | "choices";
    threshold: number;
    rows: StockOverviewRow[];
    total: number;
}>;

/** Every stock column a restock may return to: the inventory columns and the components' quantity. */
declare const STOCK_COLUMNS: {
    readonly component: {
        readonly table: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
            name: "_ecommerce_components";
            schema: undefined;
            columns: {
                id: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_components";
                    dataType: "string";
                    data: string;
                    driverParam: string;
                    notNull: true;
                    hasDefault: false;
                    isPrimaryKey: true;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: [string, ...string[]];
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                sku: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_components";
                    dataType: "string";
                    data: string;
                    driverParam: string;
                    notNull: true;
                    hasDefault: false;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: [string, ...string[]];
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                name: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_components";
                    dataType: "string";
                    data: string;
                    driverParam: string;
                    notNull: true;
                    hasDefault: false;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: [string, ...string[]];
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                quantity: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_components";
                    dataType: "number int53";
                    data: number;
                    driverParam: number;
                    notNull: true;
                    hasDefault: true;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: undefined;
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                createdAt: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_components";
                    dataType: "object date";
                    data: Date;
                    driverParam: number;
                    notNull: true;
                    hasDefault: false;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: undefined;
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                updatedAt: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_components";
                    dataType: "object date";
                    data: Date;
                    driverParam: number;
                    notNull: true;
                    hasDefault: false;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: undefined;
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
            };
            dialect: "sqlite";
        }>;
        readonly quantity: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: string;
            tableName: "_ecommerce_components";
            dataType: "number int53";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}>;
    };
    readonly product: {
        readonly table: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
            name: "_ecommerce_products";
            schema: undefined;
            columns: {
                id: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_products";
                    dataType: "string";
                    data: string;
                    driverParam: string;
                    notNull: true;
                    hasDefault: false;
                    isPrimaryKey: true;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: [string, ...string[]];
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                name: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_products";
                    dataType: "string";
                    data: string;
                    driverParam: string;
                    notNull: true;
                    hasDefault: false;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: [string, ...string[]];
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                slug: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_products";
                    dataType: "string";
                    data: string;
                    driverParam: string;
                    notNull: true;
                    hasDefault: false;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: [string, ...string[]];
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                sku: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_products";
                    dataType: "string";
                    data: string;
                    driverParam: string;
                    notNull: false;
                    hasDefault: false;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: [string, ...string[]];
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                description: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_products";
                    dataType: "string";
                    data: string;
                    driverParam: string;
                    notNull: false;
                    hasDefault: false;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: [string, ...string[]];
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                images: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_products";
                    dataType: "object json";
                    data: string[];
                    driverParam: string;
                    notNull: true;
                    hasDefault: true;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: undefined;
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                categoryIds: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_products";
                    dataType: "object json";
                    data: string[];
                    driverParam: string;
                    notNull: true;
                    hasDefault: true;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: undefined;
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                tagIds: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_products";
                    dataType: "object json";
                    data: string[];
                    driverParam: string;
                    notNull: true;
                    hasDefault: true;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: undefined;
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                basePrice: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_products";
                    dataType: "number int53";
                    data: number;
                    driverParam: number;
                    notNull: true;
                    hasDefault: true;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: undefined;
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                isPhysical: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_products";
                    dataType: "boolean";
                    data: boolean;
                    driverParam: number;
                    notNull: true;
                    hasDefault: true;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: undefined;
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                inventoryQuantity: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_products";
                    dataType: "number int53";
                    data: number;
                    driverParam: number;
                    notNull: true;
                    hasDefault: true;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: undefined;
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                type: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_products";
                    dataType: "string enum";
                    data: "standard" | "digital" | "subscription";
                    driverParam: string;
                    notNull: true;
                    hasDefault: true;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: ["standard", "digital", "subscription"];
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                status: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_products";
                    dataType: "string enum";
                    data: "draft" | "active" | "archived";
                    driverParam: string;
                    notNull: true;
                    hasDefault: true;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: ["draft", "active", "archived"];
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                createdAt: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_products";
                    dataType: "object date";
                    data: Date;
                    driverParam: number;
                    notNull: true;
                    hasDefault: false;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: undefined;
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                updatedAt: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_products";
                    dataType: "object date";
                    data: Date;
                    driverParam: number;
                    notNull: true;
                    hasDefault: false;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: undefined;
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
            };
            dialect: "sqlite";
        }>;
        readonly quantity: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: string;
            tableName: "_ecommerce_products";
            dataType: "number int53";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}>;
    };
    readonly variant: {
        readonly table: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
            name: "_ecommerce_product_variants";
            schema: undefined;
            columns: {
                id: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_product_variants";
                    dataType: "string";
                    data: string;
                    driverParam: string;
                    notNull: true;
                    hasDefault: false;
                    isPrimaryKey: true;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: [string, ...string[]];
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                productId: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_product_variants";
                    dataType: "string";
                    data: string;
                    driverParam: string;
                    notNull: true;
                    hasDefault: false;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: [string, ...string[]];
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                variantId: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_product_variants";
                    dataType: "string";
                    data: string;
                    driverParam: string;
                    notNull: false;
                    hasDefault: false;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: [string, ...string[]];
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                name: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_product_variants";
                    dataType: "string";
                    data: string;
                    driverParam: string;
                    notNull: true;
                    hasDefault: false;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: [string, ...string[]];
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                sku: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_product_variants";
                    dataType: "string";
                    data: string;
                    driverParam: string;
                    notNull: false;
                    hasDefault: false;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: [string, ...string[]];
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                priceOverride: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_product_variants";
                    dataType: "number int53";
                    data: number;
                    driverParam: number;
                    notNull: false;
                    hasDefault: false;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: undefined;
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                inventoryQuantity: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_product_variants";
                    dataType: "number int53";
                    data: number;
                    driverParam: number;
                    notNull: true;
                    hasDefault: true;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: undefined;
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                createdAt: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_product_variants";
                    dataType: "object date";
                    data: Date;
                    driverParam: number;
                    notNull: true;
                    hasDefault: false;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: undefined;
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                updatedAt: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_product_variants";
                    dataType: "object date";
                    data: Date;
                    driverParam: number;
                    notNull: true;
                    hasDefault: false;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: undefined;
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
            };
            dialect: "sqlite";
        }>;
        readonly quantity: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: string;
            tableName: "_ecommerce_product_variants";
            dataType: "number int53";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}>;
    };
    readonly stock: {
        readonly table: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
            name: "_ecommerce_stocks";
            schema: undefined;
            columns: {
                id: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_stocks";
                    dataType: "string";
                    data: string;
                    driverParam: string;
                    notNull: true;
                    hasDefault: false;
                    isPrimaryKey: true;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: [string, ...string[]];
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                productVariantValueId: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_stocks";
                    dataType: "string";
                    data: string;
                    driverParam: string;
                    notNull: true;
                    hasDefault: false;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: [string, ...string[]];
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                quantity: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_stocks";
                    dataType: "number int53";
                    data: number;
                    driverParam: number;
                    notNull: true;
                    hasDefault: true;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: undefined;
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                createdAt: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_stocks";
                    dataType: "object date";
                    data: Date;
                    driverParam: number;
                    notNull: true;
                    hasDefault: false;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: undefined;
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
                updatedAt: drizzle_orm_sqlite_core.SQLiteColumn<{
                    name: string;
                    tableName: "_ecommerce_stocks";
                    dataType: "object date";
                    data: Date;
                    driverParam: number;
                    notNull: true;
                    hasDefault: false;
                    isPrimaryKey: false;
                    isAutoincrement: false;
                    hasRuntimeDefault: false;
                    enumValues: undefined;
                    baseColumn: never;
                    identity: undefined;
                    generated: undefined;
                }, {}>;
            };
            dialect: "sqlite";
        }>;
        readonly quantity: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: string;
            tableName: "_ecommerce_stocks";
            dataType: "number int53";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}>;
    };
};

/** Backfill a historical parcel explicitly; never infer its contents from the whole order. */
declare function recordParcelContents(env: TalismanEnv, input: unknown, actor: string): Promise<{
    parcelId: string;
    orderId: string;
    duplicate: boolean;
} | {
    parcelId: string;
    orderId: string;
}>;
/** Inventory receipt and financial refunds are independent. Stock comes from checkout snapshots,
 * never today's component recipe, and an atomic cap also covers the legacy whole-hold restock. */
declare function receiveOrderReturn(env: TalismanEnv, input: unknown, actor: string): Promise<{
    receiptId: string;
    orderId: string;
    restocked: {
        id: string;
        orderId: string;
        receiptId: string;
        targetType: "product" | "variant" | "stock" | "component";
        targetId: string;
        quantity: number;
        reservationType: "component" | "inventory";
        reservationId: string;
    }[];
    duplicate: boolean;
} | {
    receiptId: string;
    orderId: string;
    restocked: {
        receiptId: string;
        id: string;
        orderId: string;
        reservationType: "component" | "inventory";
        reservationId: string;
        targetType: "product" | "variant" | "stock" | "component";
        targetId: string;
        quantity: number;
    }[];
}>;
/** One order's quantities, immutable parcel contents and intake history, without catalog recipe reads. */
declare function readOrderWarehouse(env: TalismanEnv, input: unknown): Promise<{
    orderId: string;
    status: string;
    fulfillmentStatus: "unfulfilled" | "partially_fulfilled" | "fulfilled";
    lines: {
        lineIndex: number;
        quantity: number;
        name: string;
        sku: string | null;
        shipped: number;
        received: number;
        remaining: number | null;
        returnable: number;
        restockMapped: boolean;
    }[];
    unrecorded: {
        id: string;
        createdAt: string;
        note: string;
    }[];
    parcels: {
        actorName: string;
        createdAt: string;
        id: string;
        items: ParcelItem[];
        orderId: string;
        actor: string;
        reason: string;
        fingerprint: string;
        fulfillmentId: string;
        source: "shipment" | "backfill";
    }[];
    returns: {
        actorName: string;
        createdAt: string;
        inspectionPending: {
            lineIndex: number;
            quantity: number;
        }[];
        inspections: {
            actorName: string;
            createdAt: string;
            id: string;
            items: InspectedItem[];
            orderId: string;
            actor: string;
            reason: string;
            fingerprint: string;
            receiptId: string;
            stock: {
                id: string;
                orderId: string;
                targetType: "product" | "variant" | "stock" | "component";
                targetId: string;
                quantity: number;
                reservationType: "component" | "inventory";
                reservationId: string;
                inspectionId: string;
            }[];
        }[];
        id: string;
        items: ReturnedItem[];
        orderId: string;
        actor: string;
        reason: string;
        fingerprint: string;
        stock: {
            id: string;
            orderId: string;
            receiptId: string;
            targetType: "product" | "variant" | "stock" | "component";
            targetId: string;
            quantity: number;
            reservationType: "component" | "inventory";
            reservationId: string;
        }[];
    }[];
    shippingAddress: {
        name?: string;
        line1?: string;
        line2?: string;
        city?: string;
        state?: string;
        postalCode?: string;
        country?: string;
    } | null;
    canReceive: boolean;
}>;
declare function recordStockMovement(env: TalismanEnv, input: unknown, actor: string): Promise<{
    movementId: string;
    before: number;
    after: number;
    duplicate: boolean;
} | {
    movementId: string;
    before: number;
    after: number;
}>;
declare function listStockLocations(env: TalismanEnv, input?: unknown): Promise<{
    total: number;
    rows: {
        updatedAt: string;
        type: keyof typeof STOCK_COLUMNS;
        id: string;
        name: string;
        sku: string | null;
        quantity: number;
        updated: number;
    }[];
    search: string;
    offset: number;
}>;
declare function readStockHistory(env: TalismanEnv, input: unknown): Promise<{
    total: number;
    rows: {
        actorName: string | null;
        createdAt: string;
        id: string;
        kind: string;
        delta: number;
        beforeQuantity: number | null;
        afterQuantity: number | null;
        actor: string | null;
        reason: string;
        orderId: string | null;
    }[];
    targetType: "product" | "variant" | "stock" | "component";
    targetId: string;
    offset: number;
}>;
/** Resolve received goods without changing the intake quantity or the payment refund. */
declare function inspectOrderReturn(env: TalismanEnv, input: unknown, actor: string): Promise<{
    inspectionId: string;
    orderId: string;
    restocked: {
        id: string;
        orderId: string;
        targetType: "product" | "variant" | "stock" | "component";
        targetId: string;
        quantity: number;
        reservationType: "component" | "inventory";
        reservationId: string;
        inspectionId: string;
    }[];
    duplicate: boolean;
} | {
    inspectionId: string;
    orderId: string;
    restocked: {
        inspectionId: string;
        id: string;
        orderId: string;
        reservationType: "component" | "inventory";
        reservationId: string;
        targetType: "product" | "variant" | "stock" | "component";
        targetId: string;
        quantity: number;
    }[];
}>;
/** An atomic count receipt, with exact versions checked even for unchanged lines. */
declare function recordStocktake(env: TalismanEnv, input: unknown, actor: string): Promise<{
    stocktakeId: string;
    lines: StocktakeLine[];
    duplicate: boolean;
} | {
    stocktakeId: string;
    lines: {
        expectedUpdatedSeconds: number;
        name: string;
        sku: string | null;
        targetType: "product" | "variant" | "stock" | "component";
        targetId: string;
        expectedUpdatedAt: string;
        expectedQuantity: number;
        countedQuantity: number;
    }[];
}>;
declare function listStocktakes(env: TalismanEnv, input?: unknown): Promise<{
    total: number;
    rows: {
        actorName: string;
        createdAt: string;
        id: string;
        lines: StocktakeLine[];
        actor: string;
        reason: string;
        fingerprint: string;
    }[];
    offset: number;
}>;
/** Reload the selected count sheet in one bounded, typed snapshot; no guessed catalog totals. */
declare function readStocktakeTargets(env: TalismanEnv, input: unknown): Promise<{
    rows: {
        updatedAt: string;
        type: keyof typeof STOCK_COLUMNS;
        id: string;
        name: string;
        sku: string | null;
        quantity: number;
        updated: number;
    }[];
}>;

/** A complete bounded download. Never silently truncate a larger selection. */
declare function exportCommerceOperations(env: TalismanEnv, input: unknown): Promise<{
    filename: string;
    rows: number;
    csv: string;
}>;

type RefundStatus = typeof RETURN_REFUND_STATUSES[number] | 'review' | 'unavailable';
type RefundQueue = {
    offset: number;
    total: number;
    filter: string;
    orderId: string;
    rows: Array<{
        id: string;
        orderId: string;
        status: RefundStatus;
        amountMinor: number;
        currency: string;
        createdAt: string;
    }>;
};
type Decision = typeof returnRefundDecisions.$inferSelect;
type RefundCase = {
    receiptId: string;
    orderId: string;
    currency: string;
    version: string;
    status: RefundStatus;
    amountMinor: number;
    items: Array<{
        name: string;
        quantity: number;
    }>;
    history: Array<Pick<Decision, 'id' | 'status' | 'amountMinor' | 'allocations' | 'reason' | 'actor'> & {
        actorName: string;
        createdAt: string;
    }>;
    sources: Array<{
        kind: typeof REFUND_SOURCE_KINDS[number];
        id: string;
        amountMinor: number;
        availableMinor: number;
        createdAt: string | null;
    }>;
};
declare function listRefundFollowUp(env: TalismanEnv, input?: unknown): Promise<RefundQueue>;
declare function readRefundCase(env: TalismanEnv, input: unknown): Promise<RefundCase>;
declare function recordRefundFollowUp(env: TalismanEnv, input: unknown, actor: string): Promise<{
    decisionId: string;
    duplicate?: boolean;
}>;

type Policy = typeof replenishmentPolicies.$inferSelect;
type Delivery = typeof replenishmentDeliveries.$inferSelect;
type ReplenishmentLocation = {
    type: typeof RESTOCK_TARGET_TYPES[number];
    id: string;
    name: string;
    sku: string | null;
    quantity: number;
    updatedAt: string;
    minimumQuantity: number | null;
    targetQuantity: number | null;
    enabled: boolean;
    incoming: number;
    suggested: number;
    policyVersion: string | null;
};
type ReplenishmentQueue = {
    offset: number;
    total: number;
    search: string;
    filter: string;
    rows: ReplenishmentLocation[];
};
type ReplenishmentDetail = {
    targetType: ReplenishmentLocation['type'];
    targetId: string;
    location: ReplenishmentLocation | null;
    deliveryOffset: number;
    deliveryTotal: number;
    policies: Array<Omit<Policy, 'fingerprint' | 'createdAt'> & {
        createdAt: string;
        actorName: string;
    }>;
    deliveries: Array<Omit<Delivery, 'fingerprint' | 'createdAt'> & {
        createdAt: string;
        actorName: string;
        received: number;
        remaining: number;
        cancelled: boolean;
        version: string;
        events: Array<{
            id: string;
            kind: 'received' | 'cancelled';
            quantity: number;
            actorName: string;
            reason: string;
            createdAt: string;
        }>;
    }>;
};
declare function listReplenishment(env: TalismanEnv, input?: unknown): Promise<ReplenishmentQueue>;
declare function readReplenishment(env: TalismanEnv, input: unknown): Promise<ReplenishmentDetail>;
declare function saveReplenishmentPolicy(env: TalismanEnv, input: unknown, actor: string): Promise<{
    policyId: string;
    duplicate?: boolean;
}>;
declare function planReplenishmentDelivery(env: TalismanEnv, input: unknown, actor: string): Promise<{
    deliveryId: string;
    duplicate?: boolean;
}>;
declare function recordReplenishmentDelivery(env: TalismanEnv, input: unknown, actor: string): Promise<{
    eventId: string;
    duplicate?: boolean;
}>;

export { type AttentionKind, CommerceOperationsConflict, type StockOverviewRow, exportCommerceOperations, inspectOrderReturn, listEmailRecovery, listRefundFollowUp, listReplenishment, listStockLocations, listStocktakes, planReplenishmentDelivery, readCommerceAttention, readOrderWarehouse, readRefundCase, readReplenishment, readStockHistory, readStockOverview, readStocktakeTargets, receiveOrderReturn, recordParcelContents, recordRefundFollowUp, recordReplenishmentDelivery, recordStockMovement, recordStocktake, retryCommerceEmail, saveReplenishmentPolicy };
