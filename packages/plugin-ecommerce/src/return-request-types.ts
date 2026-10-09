import type { ParcelItem, returnRequests, returnRequestEvents, returnRequestReceipts } from './schema';

type RequestRow = typeof returnRequests.$inferSelect;
type EventRow = typeof returnRequestEvents.$inferSelect;
type LinkRow = typeof returnRequestReceipts.$inferSelect;
type Status = EventRow['status'];

/** Public projection: no staff identity, internal reason, fingerprint or stock recipe. */
export interface CustomerReturns {
  orderId: RequestRow['orderId'];
  unknownParcelContents: boolean;
  lines: Array<{ lineIndex: number; name: string; sku: string | null; available: number }>;
  requests: Array<Pick<RequestRow, 'id' | 'reason'> & {
    status: Status;
    version: string;
    createdAt: string;
    items: Array<ParcelItem & { name: string; received: number }>;
    canCancel: boolean;
    updates: Array<{ status: Status; message: string; createdAt: string }>;
  }>;
}

export interface ReturnRequestReceipt { requestId: RequestRow['id']; duplicate?: boolean }
export interface ReturnDecisionReceipt { eventId: EventRow['id']; requestId: EventRow['requestId']; duplicate?: boolean }

/** Staff details expose only the fields the review and intake workspace needs. */
export type AdminReturnRequest = Pick<RequestRow, 'id' | 'orderId' | 'reason'> & {
  status: Status;
  version: string;
  createdAt: string;
  items: Array<ParcelItem & { name: string; restockMapped: boolean; received: number }>;
  events: Array<Pick<EventRow, 'id' | 'status' | 'reason' | 'actorKind' | 'actor' | 'customerMessage'> & {
    actorName: string;
    createdAt: string;
  }>;
  receipts: Array<Pick<LinkRow, 'receiptId'> & { createdAt: string }>;
};

export type ReturnsQueueFilter = 'active' | 'pending' | 'approved' | 'inspection' | 'all';
export interface ReturnsQueue {
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
