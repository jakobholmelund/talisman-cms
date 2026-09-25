import { PeriodDays } from './cloudflare.js';

type Database = Pick<D1Database, 'prepare'>;
type CommerceOverview = {
    periodDays: PeriodDays;
    start: string;
    end: string;
    currencies: Array<{
        currency: string;
        orders: number;
        grossSales: number;
        netSales: number;
        refunds: number;
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
declare const commerceSql: {
    totals: string;
    daily: string;
    products: string;
};
declare function fetchCommerceRange(db: Database, start: string, end: string, adminBase?: string, productCollectionSlug?: string): Promise<CommerceRange>;
declare function fetchCommerceOverview(db: Database, days: PeriodDays, adminBase?: string, productCollectionSlug?: string, now?: Date): Promise<CommerceOverview>;

export { type CommerceOverview, type CommerceRange, commerceSql, fetchCommerceOverview, fetchCommerceRange };
