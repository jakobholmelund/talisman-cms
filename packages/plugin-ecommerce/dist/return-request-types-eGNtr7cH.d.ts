import { returnRequests, REFUND_SOURCE_KINDS, ReturnExchangePreference, RETURN_REASON_CODES, returnRequestEvents, ParcelItem, returnRequestReceipts } from './schema.js';

type RequestRow = typeof returnRequests.$inferSelect;
type EventRow = typeof returnRequestEvents.$inferSelect;
type LinkRow = typeof returnRequestReceipts.$inferSelect;
type Status = EventRow['status'];
interface CustomerExchangeProgress {
    stages: Array<{
        label: string;
        quantity: number;
        nextAction: string;
    }>;
    cases: Array<{
        id: string;
        name: string;
        quantity: number;
        shipped: number;
        label: string;
        nextAction: string;
        parcels: Array<{
            quantity: number;
            returned: number;
            awaitingInspection: number;
            carrier: string | null;
            trackingNumber: string | null;
            createdAt: string;
        }>;
    }>;
}
/** Public projection: no staff identity, internal reason, fingerprint or stock recipe. */
interface CustomerReturns {
    orderId: RequestRow['orderId'];
    unknownParcelContents: boolean;
    refunds: Array<{
        receiptId: string;
        receivedAt: string;
        status: 'review' | 'needed' | 'not_needed' | 'settled';
        amountMinor: number;
        currency: string;
        updatedAt: string;
        tenders: Array<{
            kind: typeof REFUND_SOURCE_KINDS[number];
            amountMinor: number;
        }>;
    }>;
    lines: Array<{
        lineIndex: number;
        name: string;
        sku: string | null;
        available: number;
    }>;
    requests: Array<Pick<RequestRow, 'id' | 'reason'> & {
        exchangeProgress: CustomerExchangeProgress | null;
        exchangePreference: ({
            lineIndex: number;
        } & ReturnExchangePreference) | null;
        reasonCode: typeof RETURN_REASON_CODES[number];
        status: Status;
        version: string;
        createdAt: string;
        items: Array<ParcelItem & {
            name: string;
            received: number;
        }>;
        canCancel: boolean;
        updates: Array<{
            status: Status;
            message: string;
            createdAt: string;
        }>;
    }>;
}
interface ReturnRequestReceipt {
    requestId: RequestRow['id'];
    duplicate?: boolean;
}
interface ReturnDecisionReceipt {
    eventId: EventRow['id'];
    requestId: EventRow['requestId'];
    duplicate?: boolean;
}
/** Staff details expose only the fields the review and intake workspace needs. */
type AdminReturnRequest = Pick<RequestRow, 'id' | 'orderId' | 'reason'> & {
    exchangePreference: ({
        lineIndex: number;
    } & ReturnExchangePreference) | null;
    status: Status;
    version: string;
    createdAt: string;
    items: Array<ParcelItem & {
        name: string;
        restockMapped: boolean;
        received: number;
    }>;
    events: Array<Pick<EventRow, 'id' | 'status' | 'reason' | 'actorKind' | 'actor' | 'customerMessage'> & {
        actorName: string;
        createdAt: string;
    }>;
    receipts: Array<Pick<LinkRow, 'receiptId'> & {
        createdAt: string;
    }>;
};
type ReturnsQueueFilter = 'active' | 'pending' | 'approved' | 'inspection' | 'waiting_goods' | 'arrange_exchange' | 'all';
interface ReturnsQueue {
    filter: ReturnsQueueFilter;
    orderId: string;
    offset: number;
    total: number;
    rows: Array<Pick<RequestRow, 'id' | 'orderId' | 'reason'> & {
        kind: 'request' | 'inspection';
        status: string;
        createdAt: string;
        pendingUnits: number;
    }>;
}

export type { AdminReturnRequest as A, CustomerReturns as C, ReturnRequestReceipt as R, ReturnDecisionReceipt as a, ReturnsQueue as b };
