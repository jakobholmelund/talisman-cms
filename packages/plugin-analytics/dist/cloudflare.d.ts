type PeriodDays = 7 | 30;
declare function parsePeriod(value: string | null): PeriodDays;
declare function periodBounds(days: PeriodDays, now?: Date): {
    start: string;
    end: string;
};
type TrafficOverview = {
    periodDays: PeriodDays;
    start: string;
    end: string;
    pageViews: number;
    visits: number;
    trend: Array<{
        date: string;
        pageViews: number;
        visits: number;
    }>;
    pages: Array<{
        path: string;
        pageViews: number;
        visits: number;
        editHref?: string;
    }>;
    referrers: Array<{
        host: string;
        visits: number;
    }>;
    countries: Array<{
        country: string;
        visits: number;
    }>;
    vitals: {
        lcpP75Ms: number | null;
        inpP75Ms: number | null;
        clsP75: number | null;
    } | null;
    vitalsError?: string;
};
type TrafficRange = Omit<TrafficOverview, 'periodDays'>;
declare function analyticsCredentials(env: Record<string, unknown>): {
    account: string;
    site: string;
    token: string;
};
declare function trafficQuery(account: string, site: string, start: string, end: string): string;
declare function vitalsQuery(account: string, site: string, start: string, end: string): string;
declare function fetchTrafficRange(env: Record<string, unknown>, start: string, end: string, fetcher?: typeof fetch): Promise<TrafficRange>;
declare function fetchTrafficOverview(env: Record<string, unknown>, days: PeriodDays, fetcher?: typeof fetch, now?: Date): Promise<TrafficOverview>;

export { type PeriodDays, type TrafficOverview, type TrafficRange, analyticsCredentials, fetchTrafficOverview, fetchTrafficRange, parsePeriod, periodBounds, trafficQuery, vitalsQuery };
