import { TalismanEnv } from 'talisman-cms/client';
import { StocktakeLine, ParcelItem, InspectedItem, ReturnedItem, RETURN_REFUND_STATUSES, returnRefundDecisions, REFUND_SOURCE_KINDS, RESTOCK_TARGET_TYPES, replenishmentPolicies, replenishmentDeliveries, SupplierSnapshot, PurchaseLine, RETURN_REASON_CODES, SUPPLIER_ISSUE_KINDS, SUPPLIER_ISSUE_STATUSES, ReturnExchangePreference } from './schema.js';
import * as drizzle_orm_sqlite_core from 'drizzle-orm/sqlite-core';
export { d as decideReturnRequest, l as listReturnsQueue, r as readReturnRequestAdmin } from './return-requests-9ofJvWbS.js';
import { P as PaymentProviderAdapter } from './payments-DiMqRHdo.js';
import { z } from 'zod';
import 'drizzle-orm';
import './return-request-types-eGNtr7cH.js';

type AttentionKind = 'payment_review' | 'older_payments' | 'tax_review' | 'email' | 'gift_hold' | 'shipment' | 'dispute' | 'return_request' | 'inspection' | 'refund' | 'incoming' | 'supplier_issue' | 'parcel_recovery';
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
        kind: "shipment" | "order_confirmation" | "shipment_update" | "gift_card_claim" | "return_decision" | "return_received" | "return_refund" | "recovery_shipment" | "recovery_tracking" | "recovery_received";
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
    targetType: 'product' | 'variant' | 'stock' | 'component' | null;
    targetId: string | null;
};
/** Filtering and pagination happen after effective quantities are computed, so low stock beyond
 * the first catalog page remains discoverable. Bound search treats SQL wildcard characters literally. */
declare function readStockOverview(env: TalismanEnv, input?: unknown): Promise<{
    view: "components" | "choices";
    threshold: number;
    filter: "all" | "unavailable" | "low";
    search: string;
    offset: number;
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
        quantity: number;
        targetType: "product" | "variant" | "stock" | "component";
        targetId: string;
        reservationType: "component" | "inventory";
        reservationId: string;
        receiptId: string;
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
        fingerprint: string;
        actor: string;
        source: "shipment" | "backfill";
        reason: string;
        fulfillmentId: string;
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
            fingerprint: string;
            actor: string;
            reason: string;
            receiptId: string;
            stock: {
                id: string;
                orderId: string;
                quantity: number;
                targetType: "product" | "variant" | "stock" | "component";
                targetId: string;
                reservationType: "component" | "inventory";
                reservationId: string;
                inspectionId: string;
            }[];
        }[];
        id: string;
        items: ReturnedItem[];
        orderId: string;
        fingerprint: string;
        actor: string;
        reason: string;
        stock: {
            id: string;
            orderId: string;
            quantity: number;
            targetType: "product" | "variant" | "stock" | "component";
            targetId: string;
            reservationType: "component" | "inventory";
            reservationId: string;
            receiptId: string;
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
    targetType?: "product" | "variant" | "stock" | "component" | undefined;
    targetId?: string | undefined;
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
        quantity: number;
        targetType: "product" | "variant" | "stock" | "component";
        targetId: string;
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
        expectedQuantity: number;
        expectedUpdatedAt: string;
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
    paymentProvider: string | null;
    giftCardRemainingMinor: number;
    requestId: string | null;
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

declare function listSuppliers(env: TalismanEnv, input?: unknown): Promise<{
    total: number;
    rows: {
        active: boolean;
        id: string;
        version: string;
        name: string;
        contact: string;
        address: string;
    }[];
    offset: number;
    filter: "active" | "all";
    search: string;
}>;
declare function saveSupplier(env: TalismanEnv, input: unknown, actor: string): Promise<{
    supplierId: string;
    revisionId: string;
    duplicate: boolean;
} | {
    supplierId: string;
    revisionId: string;
}>;
declare function savePurchaseOrder(env: TalismanEnv, input: unknown, actor: string): Promise<{
    purchaseOrderId: string;
    eventId: string;
    duplicate: boolean;
} | {
    purchaseOrderId: string;
    eventId: string;
}>;
declare function recordPurchaseOrder(env: TalismanEnv, input: unknown, actor: string): Promise<{
    purchaseOrderId: string;
    eventId: string;
    duplicate: boolean;
} | {
    purchaseOrderId: string;
    eventId: string;
}>;
declare function listPurchaseOrders(env: TalismanEnv, input?: unknown): Promise<{
    total: number;
    rows: {
        createdAt: string;
        id: string;
        supplierId: string;
        version: string;
        status: "draft" | "ordered" | "cancelled";
        reference: string;
        expectedDate: string;
        supplier: string;
        outstanding: number;
        openIssues: number;
    }[];
    offset: number;
    filter: "draft" | "cancelled" | "ordered" | "open" | "all" | "completed";
    search: string;
}>;
declare function readPurchaseOrder(env: TalismanEnv, input: unknown): Promise<{
    id: string;
    supplierId: string;
    currentSupplier: {
        active: boolean;
        version: string;
        name: string;
        contact: string;
        address: string;
    } | null;
    version: string;
    status: "draft" | "cancelled" | "ordered";
    reference: string;
    expectedDate: string;
    supplier: SupplierSnapshot;
    lines: PurchaseLine[];
    deliveries: {
        purchaseLineId: string;
        issueAllowance: number;
        lineIndex: number;
        deliveryId: string;
        version: string;
        received: number;
        remaining: number;
        cancelled: boolean;
        location: {
            type: "product" | "variant" | "stock" | "component";
            id: string;
            name: string;
            sku: string | null;
            quantity: number;
            updatedAt: string;
        } | null;
    }[];
    history: {
        id: string;
        status: "draft" | "cancelled" | "ordered";
        reference: string;
        expectedDate: string;
        lines: PurchaseLine[];
        actorName: string;
        reason: string;
        createdAt: string;
    }[];
    historyTruncated: boolean;
}>;

/** UTC cohorts are deliberately separate from today's backlog. No shopper text or identity is returned. */
declare function readOperationsReport(env: TalismanEnv, input?: unknown): Promise<{
    recoveryActivity: {
        kind: string;
        currency: string;
        disposition: string | null;
        restock: number | null;
        records: number;
        units: number;
    }[];
    exchangeMoney: {
        kind: string;
        currency: string;
        records: number;
        amountMinor: number | null;
    }[];
    recoveryWork: {
        inspectionUnits: number;
        paymentReviews: number;
    };
    startAt: string;
    endBefore: string;
    asOf: string;
    reasons: {
        code: (typeof RETURN_REASON_CODES)[number];
        requests: number;
    }[];
    conditions: {
        condition: string;
        units: number;
        receipts: number;
    }[];
    resolutions: {
        averageHours: number;
        status: "settled" | "not_needed";
        returns: number;
        averageSeconds: number;
    }[];
    firstShipment: {
        orders: number;
        averageHours: number | null;
    };
    overdueDeliveries: {
        deliveries: number;
        units: number;
        oldestDate: string | null;
    };
    backlog: {
        kind: "supplier" | "shipping" | "returns" | "refund" | "recovery";
        count: number;
        oldestAt: string | null;
        oldestHours: number | null;
    }[];
    start: string;
    end: string;
}>;

declare function reportSupplierIssue(env: TalismanEnv, input: unknown, actor: string): Promise<{
    issueId: string;
    duplicate: boolean;
} | {
    issueId: string;
}>;
declare function recordSupplierIssue(env: TalismanEnv, input: unknown, actor: string): Promise<{
    issueId: string;
    eventId: string;
    duplicate: boolean;
} | {
    issueId: string;
    eventId: string;
}>;
declare function listSupplierIssues(env: TalismanEnv, input?: unknown): Promise<{
    total: number;
    rows: {
        createdAt: string;
        id: string;
        purchaseLineId: string;
        kind: (typeof SUPPLIER_ISSUE_KINDS)[number];
        quantity: number;
        version: string;
        status: (typeof SUPPLIER_ISSUE_STATUSES)[number];
        purchaseOrderId: string;
        deliveryId: string;
        lineIndex: number;
        reference: string;
        supplier: string;
        name: string;
    }[];
    offset: number;
    filter: "open" | "resolved" | "all";
    purchaseOrderId?: string | undefined;
}>;
declare function readSupplierIssue(env: TalismanEnv, input: unknown): Promise<{
    id: string;
    purchaseLineId: string;
    purchaseOrderId: string;
    kind: "damaged" | "short" | "incorrect";
    quantity: number;
    reason: string;
    createdAt: string;
    actorName: string;
    version: string;
    status: "open" | "resolved";
    reference: string;
    name: string;
    supplier: string;
    historyTruncated: boolean;
    history: {
        id: string;
        status: "open" | "resolved";
        reason: string;
        actorName: string;
        createdAt: string;
    }[];
}>;

declare const RECOVERY_NEXT_ACTIONS: readonly ["inspection", "review", "refund", "payment", "stock", "dispatch", "follow_up", "complete"];
type RecoveryNextAction = typeof RECOVERY_NEXT_ACTIONS[number];

/** Immutable incidents and exchange choices; no reservation, payment or original-order mutation. */
declare function createRecoveryCase(env: TalismanEnv, input: unknown, actor: string): Promise<{
    caseId: string;
    duplicate: boolean;
} | {
    caseId: string;
}>;
declare function recordRecoveryEvent(env: TalismanEnv, input: unknown, actor: string): Promise<{
    eventId: string;
    duplicate: boolean;
} | {
    eventId: string;
}>;
declare function shipRecoveryCase(env: TalismanEnv, input: unknown, actor: string, adapters?: PaymentProviderAdapter[]): Promise<{
    shipmentId: string;
    duplicate: boolean;
} | {
    shipmentId: string;
}>;
declare function listRecoveryCases(env: TalismanEnv, input?: unknown): Promise<{
    total: number;
    rows: {
        nextActionLabel: string;
        createdAt: string;
        id: string;
        lineIndex: number;
        orderId: string;
        receiptId: string | null;
        kind: "lost" | "damaged" | "exchange";
        quantity: number;
        shipped: number;
        awaitingInspection: number;
        awaitingPaymentReview: number;
        name: string;
        status: "open" | "resolved";
        nextAction: RecoveryNextAction;
    }[];
    filter: "open" | "resolved" | "all";
    kind: "damaged" | "lost" | "exchange" | "all";
    nextAction: "stock" | "complete" | "review" | "inspection" | "payment" | "all" | "refund" | "dispatch" | "follow_up";
    offset: number;
    orderId: string;
}>;
declare function readRecoveryCase(env: TalismanEnv, input: unknown): Promise<{
    adjustment: {
        amountMinor: number;
        status: string;
        paymentId: string;
    };
    awaitingPaymentReview: boolean;
    id: string;
    orderId: string;
    kind: "damaged" | "lost" | "exchange";
    lineIndex: number;
    quantity: number;
    target: {
        name: string;
        sku: string | null;
        productId: string;
        variantId: string | null;
    };
    sourceId: string | null;
    version: string;
    status: "open" | "resolved";
    remaining: number;
    shipped: number;
    reason: string;
    actorName: string;
    createdAt: string;
    redacted: boolean;
    paymentStatus: string;
    currency: string;
    shippingAddress: {
        name?: string;
        line1?: string;
        line2?: string;
        city?: string;
        state?: string;
        postalCode?: string;
        country?: string;
    } | null;
    stock: {
        name: string;
        sku: string | null;
        quantity: number;
        updatedAt: string | null;
        type: (typeof RESTOCK_TARGET_TYPES)[number];
        id: string;
        units: number;
    }[];
    historyTruncated: boolean;
    shipmentsTruncated: boolean;
    history: {
        id: string;
        kind: "shipment" | "reopen" | "note" | "resolve" | "tracking";
        status: "open" | "resolved";
        reason: string;
        actorName: string;
        createdAt: string;
    }[];
    shipments: {
        id: string;
        quantity: number;
        returned: number;
        receipts: {
            id: string;
            quantity: number;
            remaining: number;
            createdAt: string;
            inspections: {
                id: string;
                quantity: number;
                disposition: "sellable" | "damaged" | "quarantine";
                restock: boolean;
                createdAt: string;
            }[];
        }[];
        carrier: string | null;
        trackingNumber: string | null;
        createdAt: string;
    }[];
}>;
declare function readRecoveryOrder(env: TalismanEnv, input: unknown): Promise<{
    currency: string;
    lines: {
        priceAtPurchase: number;
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
    canCreate: boolean;
    replacements: {
        id: string;
        lineIndex: number;
        quantity: number;
        name: string;
        createdAt: string;
    }[];
    cases: {
        id: string;
        quantity: number;
        kind: "damaged" | "lost" | "exchange";
        fulfillmentId: string | null;
        receiptId: string | null;
        lineIndex: number;
        sourceShipmentId: string | null;
    }[];
    orderId: string;
    status: string;
    fulfillmentStatus: "unfulfilled" | "partially_fulfilled" | "fulfilled";
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
        fingerprint: string;
        actor: string;
        source: "shipment" | "backfill";
        reason: string;
        fulfillmentId: string;
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
            fingerprint: string;
            actor: string;
            reason: string;
            receiptId: string;
            stock: {
                id: string;
                orderId: string;
                quantity: number;
                targetType: "product" | "variant" | "stock" | "component";
                targetId: string;
                reservationType: "component" | "inventory";
                reservationId: string;
                inspectionId: string;
            }[];
        }[];
        id: string;
        items: ReturnedItem[];
        orderId: string;
        fingerprint: string;
        actor: string;
        reason: string;
        stock: {
            id: string;
            orderId: string;
            quantity: number;
            targetType: "product" | "variant" | "stock" | "component";
            targetId: string;
            reservationType: "component" | "inventory";
            reservationId: string;
            receiptId: string;
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
/** Server-filtered equal-price catalog choices. No choice changes a purchase or promises stock. */
declare function listExchangeChoices(env: TalismanEnv, input: unknown): Promise<{
    currency: string;
    price: number;
    total: number;
    rows: {
        productId: string;
        variantId: string | null;
        name: string;
        sku: string | null;
        price: number;
    }[];
    orderId: string;
    lineIndex: number;
    search: string;
    allowPriceDifference: boolean;
    offset: number;
}>;
/** A request's immutable receipt links provide exchange provenance, including older recorded cases. */
declare function readExchangeHandoff(env: TalismanEnv, input: unknown): Promise<{
    requestId: string;
    orderId: string;
    lineIndex: number;
    status: "closed" | "approved" | "cancelled" | "pending" | "declined";
    preference: ReturnExchangePreference;
    choice: {
        productId: string;
        variantId: string | null;
        name: string;
        sku: string | null;
        price: number;
    } | null;
    currency: string;
    canArrange: boolean;
    blockedReason: string | null;
    receipts: {
        receiptId: string;
        received: number;
        refundStatus: "needed" | "not_needed" | "settled";
        awaitingInspection: number;
        available: number;
        caseIds: string[];
    }[];
}>;

/** Receipt acknowledges physical goods only; it never promises a refund or restores stock. */
declare function receiveReplacementReturn(env: TalismanEnv, input: unknown, actor: string): Promise<{
    receiptId: string;
    duplicate: boolean;
} | {
    receiptId: string;
}>;
/** Partial dispositions use the outgoing parcel's frozen recipe, independently of checkout stock. */
declare function inspectReplacementReturn(env: TalismanEnv, input: unknown, actor: string): Promise<{
    inspectionId: string;
    duplicate: boolean;
} | {
    inspectionId: string;
}>;

/** Provider-verified extra tender. A staff assertion or unrelated payment is never sufficient. */
declare function verifyExchangeCharge(env: TalismanEnv, input: unknown, actor: string, adapters?: PaymentProviderAdapter[]): Promise<{
    decisionId: string;
    duplicate: boolean;
} | {
    decisionId: string;
}>;

/** The order detail loads a bounded chronological page only when staff open its history. */
declare function readOrderRecoveryHistory(env: TalismanEnv, input: unknown): Promise<{
    total: number;
    rows: {
        created_at_utc: string;
        actorName: string | null;
        emailNext: string | null;
        record_id: string;
        kind: string;
        order_id: string;
        case_id: string | null;
        request_id: string | null;
        shipment_id: string | null;
        receipt_id: string | null;
        verification_id: string | null;
        target_name: string;
        target_sku: string | null;
        currency: string;
        quantity: number | null;
        adjustment_minor: number | null;
        amount_minor: number | null;
        disposition: string | null;
        restock: number | null;
        carrier: string | null;
        tracking_number: string | null;
        recorded_status: string | null;
        actor: string | null;
        reason: string;
        emailStatus: string | null;
        emailAttempts: number | null;
        emailError: string | null;
    }[];
    orderId: string;
    offset: number;
}>;

declare const filtersSchema: z.ZodObject<{
    search: z.ZodDefault<z.ZodString>;
    status: z.ZodDefault<z.ZodEnum<{
        "": "";
        draft: "draft";
        active: "active";
        archived: "archived";
    }>>;
    category: z.ZodDefault<z.ZodString>;
    attention: z.ZodDefault<z.ZodEnum<{
        images: "images";
        out: "out";
        all: "all";
        price: "price";
        low: "low";
    }>>;
    threshold: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    sort: z.ZodDefault<z.ZodEnum<{
        name: "name";
        updated: "updated";
        "price-asc": "price-asc";
        "price-desc": "price-desc";
    }>>;
    page: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
}, z.core.$strict>;
type CatalogueFilters = z.infer<typeof filtersSchema>;
type CatalogueRow = {
    id: string;
    name: string;
    slug: string;
    sku: string | null;
    image: string | null;
    basePrice: number;
    status: "draft" | "active" | "archived";
    type: string;
    updatedAt: string;
    choiceCount: number;
    variantCount: number;
    inStock: number;
    lowCount: number;
    outCount: number;
    missingPrice: number;
    customPrices: number;
    inheritedPrices: number;
    minCustom: number | null;
    maxCustom: number | null;
    minPrice: number;
    maxPrice: number;
    simpleQuantity: number | null;
};
declare function readAdminCatalogue(env: TalismanEnv, input?: unknown): Promise<{
    rows: (Omit<CatalogueRow & {
        updatedSeconds: number;
    }, "updatedSeconds"> & {
        updatedAt: string;
    })[];
    counts: {
        all: number;
        images: number;
        low: number;
        out: number;
        price: number;
        total: number;
    };
    total: number;
    page: number;
    pages: number;
    pageSize: number;
    categories: {
        id: string;
        name: string;
    }[];
    filters: {
        page: number;
        search: string;
        status: "" | "draft" | "active" | "archived";
        category: string;
        attention: "images" | "out" | "all" | "price" | "low";
        threshold: number;
        sort: "name" | "updated" | "price-asc" | "price-desc";
    };
}>;
declare function readCatalogueSelection(env: TalismanEnv, input: unknown): Promise<{
    rows: (Omit<CatalogueRow & {
        updatedSeconds: number;
    }, "updatedSeconds"> & {
        updatedAt: string;
    })[];
}>;
/** Freeze absolute assignments in the reviewed request. Replaying cannot compound a percentage.
 * Each field assignment is idempotent; all actual changes share one optimistic D1 transaction. */
declare function updateCatalogue(env: TalismanEnv, input: unknown, _actor: string): Promise<{
    batchId: string;
    count: number;
}>;

export { type AttentionKind, type CatalogueFilters, type CatalogueRow, CommerceOperationsConflict, type StockOverviewRow, createRecoveryCase, exportCommerceOperations, inspectOrderReturn, inspectReplacementReturn, listEmailRecovery, listExchangeChoices, listPurchaseOrders, listRecoveryCases, listRefundFollowUp, listReplenishment, listStockLocations, listStocktakes, listSupplierIssues, listSuppliers, planReplenishmentDelivery, readAdminCatalogue, readCatalogueSelection, readCommerceAttention, readExchangeHandoff, readOperationsReport, readOrderRecoveryHistory, readOrderWarehouse, readPurchaseOrder, readRecoveryCase, readRecoveryOrder, readRefundCase, readReplenishment, readStockHistory, readStockOverview, readStocktakeTargets, readSupplierIssue, receiveOrderReturn, receiveReplacementReturn, recordParcelContents, recordPurchaseOrder, recordRecoveryEvent, recordRefundFollowUp, recordReplenishmentDelivery, recordStockMovement, recordStocktake, recordSupplierIssue, reportSupplierIssue, retryCommerceEmail, savePurchaseOrder, saveReplenishmentPolicy, saveSupplier, shipRecoveryCase, updateCatalogue, verifyExchangeCharge };
