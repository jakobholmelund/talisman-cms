import { TalismanEnv } from 'talisman-cms/client';
import { a as ReturnDecisionReceipt, b as ReturnsQueue, A as AdminReturnRequest } from './return-request-types-eGNtr7cH.js';

type ReturnOwner = {
    sessionToken?: string;
    customerId?: string;
    orderAccessToken?: string;
};
declare function decideReturnRequest(env: TalismanEnv, input: unknown, actor: string): Promise<ReturnDecisionReceipt>;
declare function readReturnRequestAdmin(env: TalismanEnv, input: unknown): Promise<AdminReturnRequest>;
/** Flat, bounded queue; a pending inspection appears even when intake had no customer request. */
declare function listReturnsQueue(env: TalismanEnv, input?: unknown): Promise<ReturnsQueue>;

export { type ReturnOwner as R, decideReturnRequest as d, listReturnsQueue as l, readReturnRequestAdmin as r };
